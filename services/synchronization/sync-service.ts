import "server-only";
import type {
  Catalog,
  CatalogCollection,
  CatalogProduct,
  SyncStats,
} from "@/types/catalog";
import type {
  Blog,
  BlogArticle,
  BlogCatalog,
  BlogSyncStats,
} from "@/types/blog";
import type { ShopCatalog, ShopContentBlock, ShopHomeContent, ShopPdpContent, ShopSyncStats } from "@/types/shop";
import { adminRequest, paginateAdmin } from "@/lib/shopify/admin";
import { storefrontRequest } from "@/lib/shopify/storefront";
import {
  ARTICLES_PAGE_QUERY,
  ARTICLE_BY_ID_QUERY,
  BLOGS_PAGE_QUERY,
  BLOG_BY_ID_QUERY,
  COLLECTIONS_PAGE_QUERY,
  COLLECTION_BY_ID_QUERY,
  METAOBJECTS_BY_IDS_QUERY,
  PRODUCTS_PAGE_QUERY,
  PRODUCT_BY_ID_QUERY,
  SHOP_QUERY,
  SHOP_PDP_QUERY,
  SHOP_CONTACT_QUERY,
} from "@/lib/shopify/queries/admin";
import { SHOP_POLICIES_QUERY } from "@/lib/shopify/queries/storefront";
import {
  normalizeArticle,
  normalizeBlog,
  normalizeCollection,
  normalizeProduct,
  referencedMetaobjectIds,
  type AdminArticleNode,
  type AdminBlogNode,
  type AdminCollectionNode,
  type AdminProductNode,
  type MetaobjectIndex,
} from "@/lib/catalog/normalize";
import {
  auditCatalog,
  catalogSchema,
  validateCatalog,
} from "@/lib/catalog/schema";
import { productRepository, redirectRepository } from "@/lib/catalog";
import { isAllowedVendor } from "@/lib/catalog/vendors";
import { blogRepository } from "@/lib/catalog/blog";
import { shopRepository } from "@/lib/catalog/shop";
import {
  acquireLock,
  readJsonFile,
  BLOG_PATH,
  CATALOG_PATH,
} from "@/lib/catalog/storage";
import { serverEnv } from "@/lib/validation/env";

export const BLOG_CATALOG_VERSION = 1;

export const SHOP_CATALOG_VERSION = 1;

export const CATALOG_VERSION = 1;

type ShopQueryResult = {
  shop: { name: string; myshopifyDomain: string; currencyCode: string };
};

export type SyncOptions = {
  pageSize?: number;
  onProgress?: (message: string) => void;
};

/** Shopify's `nodes(ids:)` accepts at most 250 ids per request. */
const METAOBJECT_BATCH_SIZE = 200;

/**
 * Batch-resolves every metaobject the given products reference, keyed by GID.
 *
 * Separate from the product query on purpose — see METAOBJECTS_BY_IDS_QUERY.
 * Returns an empty index rather than throwing when the store hasn't granted
 * `read_metaobjects`: structured specs are an enhancement, and a catalog sync
 * must not fail wholesale because one optional scope is missing.
 */
async function fetchMetaobjects(
  products: AdminProductNode[],
  report: (message: string) => void,
): Promise<MetaobjectIndex> {
  const ids = [...new Set(products.flatMap(referencedMetaobjectIds))];
  const index: MetaobjectIndex = new Map();
  if (ids.length === 0) return index;

  report(`Resolving ${ids.length} spec/feature metaobjects…`);

  for (let offset = 0; offset < ids.length; offset += METAOBJECT_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + METAOBJECT_BATCH_SIZE);
    try {
      const data = await adminRequest<{
        nodes: (Omit<MetaobjectIndex extends Map<string, infer V> ? V : never, "fields"> & {
          fields?: { key: string; value: string | null }[];
        } | null)[];
      }>({ query: METAOBJECTS_BY_IDS_QUERY, variables: { ids: batch } });

      for (const node of data.nodes) {
        // Video nodes (custom.demo_video) have sources instead of fields.
        if (node?.id) index.set(node.id, { ...node, fields: node.fields ?? [] });
      }
    } catch (error) {
      report(
        `  Skipped metaobject resolution: ${(error as Error).message.slice(0, 120)}`,
      );
      return index;
    }
  }

  return index;
}

/**
 * ShopifySyncService — the full catalog rebuild.
 *
 * Idempotent by construction: identical Shopify state produces a byte-identical
 * products.json (stable ordering everywhere, `generatedAt` excluded from the diff).
 */
export async function fullSync(options: SyncOptions = {}): Promise<SyncStats> {
  const startedAt = Date.now();
  const report = options.onProgress ?? (() => {});
  const warnings: string[] = [];
  const env = serverEnv();

  const lock = await acquireLock({ timeoutMs: 60_000 });

  try {
    report("Connecting to Shopify Admin GraphQL API…");
    const shopData = await adminRequest<ShopQueryResult>({ query: SHOP_QUERY });
    const currencyCode = shopData.shop.currencyCode;
    report(
      `Connected to ${shopData.shop.name} (${shopData.shop.myshopifyDomain}), currency ${currencyCode}`,
    );

    report("Fetching products…");
    const productNodes = await paginateAdmin<AdminProductNode>(
      PRODUCTS_PAGE_QUERY,
      "products",
      {
        pageSize: options.pageSize ?? 50,
        onPage: (nodes, page) =>
          report(`  page ${page}: ${nodes.length} products`),
      },
    );

    report("Fetching collections…");
    const collectionNodes = await paginateAdmin<AdminCollectionNode>(
      COLLECTIONS_PAGE_QUERY,
      "collections",
      {
        pageSize: 50,
        onPage: (nodes, page) =>
          report(`  page ${page}: ${nodes.length} collections`),
      },
    );

    const metaobjects = await fetchMetaobjects(productNodes, report);

    report("Normalizing…");
    const products = productNodes
      .map((node) => {
        try {
          return normalizeProduct(node, currencyCode, metaobjects);
        } catch (error) {
          warnings.push(
            `Skipped product ${node.handle}: ${(error as Error).message}`,
          );
          return null;
        }
      })
      .filter((product): product is CatalogProduct => product !== null)
      // Only the Trackify vendor belong in this storefront.
      .filter((product) => {
        if (isAllowedVendor(product.vendor)) return true;
        warnings.push(
          `Skipped product ${product.handle}: vendor "${product.vendor}" not allowed`,
        );
        return false;
      })
      // Products with no variants cannot be rendered or purchased.
      .filter((product) => {
        if (product.variants.length > 0) return true;
        warnings.push(`Skipped product ${product.handle}: no variants`);
        return false;
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    // Collection membership is derived from each product's own collections
    // connection — one traversal instead of N per-collection queries.
    const membership = new Map<string, string[]>();
    for (const product of products) {
      for (const ref of product.collections) {
        const list = membership.get(ref.id);
        if (list) list.push(product.id);
        else membership.set(ref.id, [product.id]);
      }
    }

    const collections = collectionNodes
      .map((node) => normalizeCollection(node, membership.get(node.id) ?? []))
      .sort((a, b) => a.id.localeCompare(b.id));

    const catalog: Catalog = {
      version: CATALOG_VERSION,
      generatedAt: new Date().toISOString(),
      shop: {
        domain: env.storeDomain,
        name: shopData.shop.name,
        currencyCode,
      },
      products,
      collections,
    };

    report("Validating…");
    const validation = validateCatalog(catalog);
    if (!validation.ok) {
      const detail = validation.issues
        .map((issue) => `  ${issue.path}: ${issue.message}`)
        .join("\n");
      throw new Error(
        `Catalog failed schema validation — refusing to write.\n${detail}`,
      );
    }

    const auditIssues = auditCatalog(catalogSchema.parse(catalog));
    const fatal = auditIssues.filter((issue) =>
      issue.message.includes("Duplicate handle"),
    );
    if (fatal.length > 0) {
      throw new Error(
        `Catalog has duplicate handles — refusing to write.\n${fatal
          .map((issue) => `  ${issue.path}: ${issue.message}`)
          .join("\n")}`,
      );
    }
    for (const issue of auditIssues)
      warnings.push(`${issue.path}: ${issue.message}`);

    report("Diffing against the previous catalog…");
    const previous = await readJsonFile<Catalog>(CATALOG_PATH);
    const diff = diffCatalogs(previous, catalog);

    let redirectsCreated = 0;
    for (const change of diff.handleChanges) {
      await redirectRepository.record("products", change.from, change.to);
      redirectsCreated += 1;
      report(`  redirect /products/${change.from} → /products/${change.to}`);
    }
    for (const change of diff.collectionHandleChanges) {
      await redirectRepository.record("collections", change.from, change.to);
      redirectsCreated += 1;
    }

    report("Writing data/products.json…");
    await productRepository.replaceCatalog(catalog);

    const finishedAt = Date.now();
    return {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      products: products.length,
      variants: products.reduce(
        (sum, product) => sum + product.variants.length,
        0,
      ),
      images: products.reduce((sum, product) => sum + product.images.length, 0),
      collections: collections.length,
      added: diff.added,
      updated: diff.updated,
      removed: diff.removed,
      redirectsCreated,
      warnings,
    };
  } finally {
    await lock.release();
  }
}

export type CatalogDiff = {
  added: string[];
  updated: string[];
  removed: string[];
  handleChanges: { id: string; from: string; to: string }[];
  collectionHandleChanges: { id: string; from: string; to: string }[];
};

export function diffCatalogs(
  previous: Catalog | null,
  next: Catalog,
): CatalogDiff {
  const diff: CatalogDiff = {
    added: [],
    updated: [],
    removed: [],
    handleChanges: [],
    collectionHandleChanges: [],
  };
  if (!previous) {
    diff.added = next.products.map((product) => product.handle);
    return diff;
  }

  const previousById = new Map(
    previous.products.map((product) => [product.id, product]),
  );
  const nextIds = new Set(next.products.map((product) => product.id));

  for (const product of next.products) {
    const before = previousById.get(product.id);
    if (!before) {
      diff.added.push(product.handle);
      continue;
    }
    // Same Shopify ID with a different handle == a rename, not a new product.
    if (before.handle !== product.handle) {
      diff.handleChanges.push({
        id: product.id,
        from: before.handle,
        to: product.handle,
      });
    }
    if (JSON.stringify(before) !== JSON.stringify(product))
      diff.updated.push(product.handle);
  }

  for (const product of previous.products) {
    if (!nextIds.has(product.id)) diff.removed.push(product.handle);
  }

  const previousCollections = new Map(
    previous.collections.map((collection) => [collection.id, collection]),
  );
  for (const collection of next.collections) {
    const before = previousCollections.get(collection.id);
    if (before && before.handle !== collection.handle) {
      diff.collectionHandleChanges.push({
        id: collection.id,
        from: before.handle,
        to: collection.handle,
      });
    }
  }

  return diff;
}

/* ── Incremental (webhook) paths ───────────────────────────────────────── */

export async function syncSingleProduct(
  productGid: string,
): Promise<CatalogProduct | null> {
  const data = await adminRequest<{ product: AdminProductNode | null }>({
    query: PRODUCT_BY_ID_QUERY,
    variables: { id: productGid },
  });
  if (!data.product) return null;
  // Non-Trackify vendors are never imported; null makes callers drop any copy.
  if (!isAllowedVendor(data.product.vendor)) return null;

  // Currency comes from the catalog the full sync already established.
  const meta = await productRepository.getCatalogMeta();
  const metaobjects = await fetchMetaobjects([data.product], () => {});
  const product = normalizeProduct(
    data.product,
    meta.shop.currencyCode || "USD",
    metaobjects,
  );

  const existing = await productRepository.getProductById(product.id);
  if (existing && existing.handle !== product.handle) {
    await redirectRepository.record(
      "products",
      existing.handle,
      product.handle,
    );
  }

  await productRepository.updateProduct(product);
  return product;
}

export async function syncSingleCollection(
  collectionGid: string,
): Promise<CatalogCollection | null> {
  const data = await adminRequest<{ collection: AdminCollectionNode | null }>({
    query: COLLECTION_BY_ID_QUERY,
    variables: { id: collectionGid },
  });
  if (!data.collection) return null;

  // Membership comes from the products already in the catalog, so a collection
  // update never triggers a full product re-fetch.
  const products = await productRepository.getAllProducts({
    includeUnavailable: true,
  });
  const memberIds = products
    .filter((product) =>
      product.collections.some((ref) => ref.id === collectionGid),
    )
    .map((product) => product.id);

  const existing = await productRepository.getCollectionByHandle(
    data.collection.handle,
  );
  const collection = normalizeCollection(data.collection, memberIds);

  if (
    existing &&
    existing.id === collection.id &&
    existing.handle !== collection.handle
  ) {
    await redirectRepository.record(
      "collections",
      existing.handle,
      collection.handle,
    );
  }

  await productRepository.updateCollection(collection);
  return collection;
}

/* ── Blog content ──────────────────────────────────────────────────────── */

/**
 * Full blog/article rebuild — separate from `fullSync()` because blog content
 * requires the `read_content` Admin API scope, which a store may not have
 * granted yet. Failing here must never take the product catalog down with it.
 */
export async function fullSyncBlogContent(
  options: SyncOptions = {},
): Promise<BlogSyncStats> {
  const startedAt = Date.now();
  const report = options.onProgress ?? (() => {});
  const warnings: string[] = [];

  const lock = await acquireLock({ timeoutMs: 60_000 });

  try {
    report("Fetching blogs…");
    const blogNodes = await paginateAdmin<AdminBlogNode>(
      BLOGS_PAGE_QUERY,
      "blogs",
      {
        pageSize: 50,
        onPage: (nodes, page) =>
          report(`  page ${page}: ${nodes.length} blogs`),
      },
    );

    report("Fetching articles…");
    const articleNodes = await paginateAdmin<AdminArticleNode>(
      ARTICLES_PAGE_QUERY,
      "articles",
      {
        pageSize: options.pageSize ?? 50,
        onPage: (nodes, page) =>
          report(`  page ${page}: ${nodes.length} articles`),
      },
    );

    report("Normalizing…");
    const articles = articleNodes
      .map((node) => {
        try {
          return normalizeArticle(node);
        } catch (error) {
          warnings.push(
            `Skipped article ${node.handle}: ${(error as Error).message}`,
          );
          return null;
        }
      })
      .filter((article): article is BlogArticle => article !== null)
      .sort((a, b) => a.id.localeCompare(b.id));

    // Blog membership is derived from each article's own blog reference — one
    // traversal instead of a per-blog articles query.
    const membership = new Map<string, string[]>();
    for (const article of articles) {
      const list = membership.get(article.blogId);
      if (list) list.push(article.id);
      else membership.set(article.blogId, [article.id]);
    }

    const blogs = blogNodes
      .map((node) => normalizeBlog(node, membership.get(node.id) ?? []))
      .sort((a, b) => a.id.localeCompare(b.id));

    const catalog: BlogCatalog = {
      version: BLOG_CATALOG_VERSION,
      generatedAt: new Date().toISOString(),
      blogs,
      articles,
    };

    report("Diffing against the previous blog catalog…");
    const previous = await readJsonFile<BlogCatalog>(BLOG_PATH);
    const diff = diffBlogCatalogs(previous, catalog);

    report("Writing data/blog.json…");
    await blogRepository.replaceCatalog(catalog);

    const finishedAt = Date.now();
    return {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      blogs: blogs.length,
      articles: articles.length,
      added: diff.added,
      updated: diff.updated,
      removed: diff.removed,
      warnings,
    };
  } finally {
    await lock.release();
  }
}

export type BlogCatalogDiff = {
  added: string[];
  updated: string[];
  removed: string[];
};

export function diffBlogCatalogs(
  previous: BlogCatalog | null,
  next: BlogCatalog,
): BlogCatalogDiff {
  const key = (article: BlogArticle) =>
    `${article.blogHandle}/${article.handle}`;

  if (!previous) {
    return { added: next.articles.map(key), updated: [], removed: [] };
  }

  const previousById = new Map(
    previous.articles.map((article) => [article.id, article]),
  );
  const nextIds = new Set(next.articles.map((article) => article.id));

  const diff: BlogCatalogDiff = { added: [], updated: [], removed: [] };

  for (const article of next.articles) {
    const before = previousById.get(article.id);
    if (!before) {
      diff.added.push(key(article));
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(article))
      diff.updated.push(key(article));
  }

  for (const article of previous.articles) {
    if (!nextIds.has(article.id)) diff.removed.push(key(article));
  }

  return diff;
}

/* ── Shop details (contact + policies) ───────────────────────────────────
 * Two different Shopify APIs (Admin for contact, Storefront for policies),
 * one small file — both change rarely and are read together on the same
 * pages. No add/updated/removed diffing like products/blog: this is a
 * single object, not a list, so a sync either succeeds and replaces it
 * whole or fails and leaves the previous copy in place.
 * ─────────────────────────────────────────────────────────────────────── */

type ShopContactQueryResult = {
  shop: {
    email: string | null;
    billingAddress: {
      phone: string | null;
      province: string | null;
      country: string | null;
    } | null;
  };
};

type ShopMetaobjectNode = {
  id: string;
  fields?: {
    key: string;
    value: string | null;
    reference?: { image?: { url: string; width: number | null; height: number | null; altText: string | null } | null } | null;
  }[];
} | null;

/**
 * Shop `custom.*` metafields -> the PDP's store-wide content and the
 * homepage's content. Unset strings stay null and unset lists stay empty so
 * the storefront hides the matching section instead of guessing. Every
 * metaobject list resolves through the same batch query products use.
 */
async function fetchShopContent(): Promise<{ pdp: ShopPdpContent; home: ShopHomeContent }> {
  const { shop } = await adminRequest<{
    shop: { metafields: { nodes: { key: string; value: string }[] } };
  }>({ query: SHOP_PDP_QUERY });
  const value = (key: string) =>
    shop.metafields.nodes.find((node) => node.key === key)?.value.trim() || null;
  const ids = (key: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(value(key) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return []; // Malformed list — render nothing rather than fail the sync.
    }
  };

  const lists = {
    trust: ids("trust_points"),
    intro: ids("home_intro"),
    differentiators: ids("home_differentiators"),
    lifestyle: ids("home_lifestyle"),
    story: ids("home_story"),
    faq: ids("home_faq"),
  };
  const allIds = [...new Set(Object.values(lists).flat())];
  const index = new Map<string, NonNullable<ShopMetaobjectNode>>();
  if (allIds.length) {
    const data = await adminRequest<{ nodes: ShopMetaobjectNode[] }>({
      query: METAOBJECTS_BY_IDS_QUERY,
      variables: { ids: allIds },
    });
    for (const node of data.nodes) if (node?.id) index.set(node.id, node);
  }
  const field = (node: NonNullable<ShopMetaobjectNode>, key: string) =>
    node.fields?.find((f) => f.key === key);

  const blocks = (list: string[]): ShopContentBlock[] =>
    list.flatMap((id) => {
      const node = index.get(id);
      if (!node) return [];
      const label = field(node, "label")?.value;
      const body = field(node, "body")?.value;
      if (!label || !body) return [];
      const image = field(node, "image")?.reference?.image;
      return [
        {
          icon: field(node, "icon")?.value ?? null,
          label,
          body,
          image: image?.url
            ? { url: image.url, width: image.width ?? null, height: image.height ?? null, altText: image.altText ?? null }
            : null,
        },
      ];
    });

  const faq = lists.faq.flatMap((id) => {
    const node = index.get(id);
    const question = node && field(node, "question")?.value;
    const answer = node && field(node, "answer")?.value;
    return question && answer ? [{ question, answer }] : [];
  });

  const announcement = value("announcement");
  const announcements = (() => {
    try {
      const parsed: unknown = JSON.parse(value("announcements") ?? "[]");
      const list = Array.isArray(parsed)
        ? parsed.filter((line): line is string => typeof line === "string" && line.trim() !== "")
        : [];
      return list.length ? list : announcement ? [announcement] : [];
    } catch {
      return announcement ? [announcement] : [];
    }
  })();

  return {
    pdp: {
      announcement,
      announcements,
      shipping: {
        processingTime: value("shipping_processing_time"),
        deliveryEstimate: value("shipping_delivery_estimate"),
        costNote: value("shipping_cost_note"),
        regions: value("shipping_regions"),
      },
      trustPoints: blocks(lists.trust).map(({ icon, label, body }) => ({ icon, label, body })),
    },
    home: {
      featuredCollectionId: value("home_featured_collection"),
      spotlightProductId: value("home_spotlight_product"),
      intro: blocks(lists.intro),
      differentiators: blocks(lists.differentiators),
      lifestyle: blocks(lists.lifestyle),
      story: blocks(lists.story),
      faq,
    },
  };
}

export async function fullSyncShopContent(
  options: SyncOptions = {},
): Promise<ShopSyncStats> {
  const startedAt = Date.now();
  const report = options.onProgress ?? (() => {});
  const warnings: string[] = [];

  const lock = await acquireLock({ timeoutMs: 30_000 });

  try {
    report("Fetching store contact details…");
    const contact = await adminRequest<ShopContactQueryResult>({
      query: SHOP_CONTACT_QUERY,
    })
      .then(({ shop }) => ({
        email: shop.email,
        phone: shop.billingAddress?.phone ?? null,
        // Only region + country are stored — never the full street address.
        address: shop.billingAddress
          ? {
              province: shop.billingAddress.province,
              country: shop.billingAddress.country,
            }
          : null,
      }))
      .catch((error) => {
        warnings.push(`Store contact details: ${(error as Error).message}`);
        return { email: null, phone: null, address: null };
      });

    report("Fetching store policies…");
    const policies = await storefrontRequest<{ shop: ShopCatalog["policies"] }>(
      { query: SHOP_POLICIES_QUERY },
    )
      .then(({ shop }) => shop)
      .catch((error) => {
        warnings.push(`Store policies: ${(error as Error).message}`);
        return {
          termsOfService: null,
          privacyPolicy: null,
          refundPolicy: null,
          shippingPolicy: null,
        };
      });

    report("Fetching store-wide page content…");
    const content = await fetchShopContent().catch((error) => {
      warnings.push(`Store page content: ${(error as Error).message}`);
      return undefined;
    });

    const catalog: ShopCatalog = {
      version: SHOP_CATALOG_VERSION,
      generatedAt: new Date().toISOString(),
      contact,
      policies,
      ...(content ? { pdp: content.pdp, home: content.home } : {}),
    };

    report("Writing data/shop.json…");
    await shopRepository.replaceCatalog(catalog);

    const finishedAt = Date.now();
    return {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      hasContactEmail: contact.email !== null,
      hasContactAddress: contact.address !== null,
      policiesFound: Object.values(policies).filter((policy) => policy !== null)
        .length,
      warnings,
    };
  } finally {
    await lock.release();
  }
}

/* ── Incremental (webhook) paths ───────────────────────────────────────── */

export async function syncSingleArticle(
  articleGid: string,
): Promise<BlogArticle | null> {
  const data = await adminRequest<{ article: AdminArticleNode | null }>({
    query: ARTICLE_BY_ID_QUERY,
    variables: { id: articleGid },
  });
  if (!data.article) return null;

  const article = normalizeArticle(data.article);
  await blogRepository.updateArticle(article);
  return article;
}

export async function syncSingleBlog(blogGid: string): Promise<Blog | null> {
  const data = await adminRequest<{ blog: AdminBlogNode | null }>({
    query: BLOG_BY_ID_QUERY,
    variables: { id: blogGid },
  });
  if (!data.blog) return null;

  // Membership comes from the articles already in the catalog, so a blog
  // update never triggers a full article re-fetch.
  const articles = await blogRepository.getAllArticles({
    includeUnpublished: true,
  });
  const memberIds = articles
    .filter((article) => article.blogId === blogGid)
    .map((article) => article.id);

  const blog = normalizeBlog(data.blog, memberIds);
  await blogRepository.updateBlog(blog);
  return blog;
}

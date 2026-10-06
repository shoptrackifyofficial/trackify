/**
 * Admin GraphQL API documents. Server-side only.
 *
 * Everything here is read-only against the catalog. No order/customer reads are
 * declared, so the app never needs protected-customer-data scopes.
 */

const PRODUCT_FIELDS = /* GraphQL */ `
  fragment ProductFields on Product {
    id
    handle
    title
    description
    descriptionHtml
    vendor
    productType
    tags
    status
    createdAt
    updatedAt
    publishedAt
    totalInventory
    seo {
      title
      description
    }
    options(first: 5) {
      id
      name
      position
      values
    }
    featuredMedia {
      id
    }
    media(first: 25) {
      nodes {
        id
        mediaContentType
        alt
        preview {
          image {
            id
            url
            width
            height
            altText
          }
        }
        ... on Video {
          sources {
            url
            mimeType
            format
          }
        }
        ... on Model3d {
          sources {
            url
            mimeType
            format
          }
        }
        ... on ExternalVideo {
          embedUrl
          host
        }
      }
    }
    # Duplicates the media connection above, but variant.image.id is a
    # ProductImage id that only appears here — dropping it would break
    # variant colour swatches.
    images(first: 25) {
      nodes {
        id
        url
        width
        height
        altText
      }
    }
    collections(first: 25) {
      nodes {
        id
        handle
        title
      }
    }
    metafields(first: 40) {
      nodes {
        namespace
        key
        value
        type
      }
    }
    variants(first: 100) {
      nodes {
        id
        title
        sku
        barcode
        price
        compareAtPrice
        position
        availableForSale
        inventoryQuantity
        inventoryPolicy
        selectedOptions {
          name
          value
        }
        image {
          id
        }
        inventoryItem {
          requiresShipping
          measurement {
            weight {
              value
              unit
            }
          }
        }
      }
    }
  }
`;

export const PRODUCTS_PAGE_QUERY = /* GraphQL */ `
  ${PRODUCT_FIELDS}
  query ProductsPage($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, sortKey: ID, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ...ProductFields
      }
    }
  }
`;

export const PRODUCT_BY_ID_QUERY = /* GraphQL */ `
  ${PRODUCT_FIELDS}
  query ProductById($id: ID!) {
    product(id: $id) {
      ...ProductFields
    }
  }
`;

/**
 * Resolves `custom.specs` / `custom.feature_highlights` metaobjects by id,
 * including each entry's image/video file reference.
 *
 * Deliberately a separate query rather than a nested selection on the product
 * query: nesting it there applies the file-reference cost to all 15 metafield
 * slots on every product, which exceeds the Admin API's 1000-point
 * single-query limit. Fetching only the ids actually referenced costs a
 * fraction of that, and the sync batches them so it stays one extra request.
 */
export const METAOBJECTS_BY_IDS_QUERY = /* GraphQL */ `
  query MetaobjectsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on MediaImage {
        id
        alt
        image {
          url
          width
          height
          altText
        }
      }
      ... on Video {
        id
        alt
        sources {
          url
          mimeType
          format
        }
        preview {
          image {
            url
          }
        }
      }
      ... on Metaobject {
        id
        fields {
          key
          value
          reference {
            ... on MediaImage {
              id
              image {
                url
                width
                height
                altText
              }
            }
            ... on Video {
              id
              sources {
                url
                mimeType
                format
              }
              preview {
                image {
                  url
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const COLLECTIONS_PAGE_QUERY = /* GraphQL */ `
  query CollectionsPage($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: ID) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        description
        descriptionHtml
        updatedAt
        sortOrder
        seo {
          title
          description
        }
        image {
          id
          url
          width
          height
          altText
        }
      }
    }
  }
`;

export const COLLECTION_BY_ID_QUERY = /* GraphQL */ `
  query CollectionById($id: ID!) {
    collection(id: $id) {
      id
      handle
      title
      description
      descriptionHtml
      updatedAt
      sortOrder
      seo {
        title
        description
      }
      image {
        id
        url
        width
        height
        altText
      }
    }
  }
`;

/* ── Blog content ──────────────────────────────────────────────────────────
 * Requires the `read_content` Admin API access scope. If that scope is not
 * granted on this store's custom app, `blogs`/`articles` come back with a
 * GraphQL ACCESS_DENIED error rather than an empty list — surfaced clearly by
 * the sync service rather than silently producing an empty blog.json.
 * ─────────────────────────────────────────────────────────────────────────── */

const ARTICLE_FIELDS = /* GraphQL */ `
  fragment ArticleFields on Article {
    id
    handle
    title
    body
    summary
    tags
    isPublished
    createdAt
    updatedAt
    publishedAt
    image {
      id
      url
      width
      height
      altText
    }
    author {
      name
    }
    blog {
      id
      handle
      title
    }
  }
`;

export const ARTICLES_PAGE_QUERY = /* GraphQL */ `
  ${ARTICLE_FIELDS}
  query ArticlesPage($first: Int!, $after: String) {
    articles(first: $first, after: $after, sortKey: ID) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ...ArticleFields
      }
    }
  }
`;

export const ARTICLE_BY_ID_QUERY = /* GraphQL */ `
  ${ARTICLE_FIELDS}
  query ArticleById($id: ID!) {
    article(id: $id) {
      ...ArticleFields
    }
  }
`;

export const BLOGS_PAGE_QUERY = /* GraphQL */ `
  query BlogsPage($first: Int!, $after: String) {
    blogs(first: $first, after: $after, sortKey: ID) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        tags
        updatedAt
      }
    }
  }
`;

export const BLOG_BY_ID_QUERY = /* GraphQL */ `
  query BlogById($id: ID!) {
    blog(id: $id) {
      id
      handle
      title
      tags
      updatedAt
    }
  }
`;

export const SHOP_QUERY = /* GraphQL */ `
  query Shop {
    shop {
      name
      myshopifyDomain
      currencyCode
    }
  }
`;

/** Store-wide PDP content: announcement, shipping facts, trust point references. */
export const SHOP_PDP_QUERY = /* GraphQL */ `
  query ShopPdp {
    shop {
      metafields(namespace: "custom", first: 40) {
        nodes {
          key
          value
        }
      }
    }
  }
`;

/** Store details from Shopify Admin → Settings → Store details, for the "Contact us" page. */
export const SHOP_CONTACT_QUERY = /* GraphQL */ `
  query ShopContact {
    shop {
      email
      billingAddress {
        phone
        province
        country
      }
    }
  }
`;

export const INVENTORY_ITEM_VARIANTS_QUERY = /* GraphQL */ `
  query InventoryItemVariants($id: ID!) {
    inventoryItem(id: $id) {
      id
      variant {
        id
        product {
          id
        }
      }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query WebhookSubscriptions {
    webhookSubscriptions(first: 100) {
      nodes {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = /* GraphQL */ `
  mutation WebhookCreate(
    $topic: WebhookSubscriptionTopic!
    $callbackUrl: URL!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription {
        id
        topic
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/* ── Customer ↔ cart link ──────────────────────────────────────────────────
 * Shopify's Cart API is keyed by cart ID only — there is no query that returns
 * "the cart belonging to this customer", and `buyerIdentity.customerAccessToken`
 * only authenticates the cart at checkout, it does not make the cart findable
 * later. To restore a signed-in shopper's bag on another device the mapping has
 * to be stored somewhere, and a customer metafield is the Shopify-native place
 * to keep it without introducing a separate customer database.
 * ─────────────────────────────────────────────────────────────────────────── */

export const CUSTOMER_CART_METAFIELD_QUERY = /* GraphQL */ `
  query CustomerCartMetafield($id: ID!, $namespace: String!, $key: String!) {
    customer(id: $id) {
      id
      metafield(namespace: $namespace, key: $key) {
        id
        value
        updatedAt
      }
    }
  }
`;

export const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

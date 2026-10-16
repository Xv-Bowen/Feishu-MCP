declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    FEISHU_APP_ID?: string;
    FEISHU_APP_SECRET?: string;
    SITE_ORIGIN?: string;
    TOKEN_ENCRYPTION_KEY?: string;
    SITE_SERVICE_ACCESS?: string;
    CLIENT_OAUTH_ORIGIN?: string;
    CLIENT_MCP_PUBLIC?: string;
    MCP_OAUTH_CLIENT_ID?: string;
  }
}

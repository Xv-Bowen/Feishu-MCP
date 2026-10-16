import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const connections = sqliteTable("feishu_connections", {
  userId: text("user_id").primaryKey(),
  encryptedTokens: text("encrypted_tokens").notNull(),
  expiresAt: integer("expires_at").notNull(),
  name: text("name").notNull(),
  openId: text("open_id").notNull(),
  scope: text("scope").notNull(),
  refreshLock: text("refresh_lock"),
  lockExpiresAt: integer("lock_expires_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthStates = sqliteTable("feishu_oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  userId: text("user_id").notNull(),
  encryptedVerifier: text("encrypted_verifier").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const clientKeys = sqliteTable("feishu_client_keys", {
  keyHash: text("key_hash").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const mcpOAuthClients = sqliteTable("feishu_mcp_oauth_clients", {
  clientId: text("client_id").primaryKey(),
  redirectUri: text("redirect_uri").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const mcpOAuthRequests = sqliteTable("feishu_mcp_oauth_requests", {
  requestHash: text("request_hash").primaryKey(),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  challenge: text("challenge").notNull(),
  state: text("state").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  csrfHash: text("csrf_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const mcpOAuthCodes = sqliteTable("feishu_mcp_oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  challenge: text("challenge").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const mcpOAuthGrants = sqliteTable("feishu_mcp_oauth_grants", {
  grantId: text("grant_id").primaryKey(),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const mcpOAuthAccess = sqliteTable("feishu_mcp_oauth_access", {
  keyHash: text("key_hash").primaryKey(),
  grantId: text("grant_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const mcpOAuthRefresh = sqliteTable("feishu_mcp_oauth_refresh", {
  keyHash: text("key_hash").primaryKey(),
  grantId: text("grant_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  rotationId: text("rotation_id"),
});

export const writeOperations = sqliteTable("feishu_write_operations", {
  keyHash: text("key_hash").primaryKey(), userId: text("user_id").notNull(),
  toolName: text("tool_name").notNull(), payloadHash: text("payload_hash").notNull(),
  claim: text("claim").notNull(), status: text("status").notNull(),
  encryptedResult: text("encrypted_result"), createdAt: integer("created_at").notNull(),
});

export const watches = sqliteTable("feishu_watches", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), enabled: integer("enabled").notNull().default(1),
  encryptedConfig: text("encrypted_config").notNull(), encryptedState: text("encrypted_state").notNull(),
  updatedAt: integer("updated_at").notNull(), checkedAt: integer("checked_at"), lock: text("lock"), lockExpiresAt: integer("lock_expires_at"),
}, table => [index("feishu_watches_user").on(table.userId)]);

export const watchEvents = sqliteTable("feishu_watch_events", {
  id: text("id").primaryKey(), watchId: text("watch_id").notNull(), userId: text("user_id").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(), observedAt: integer("observed_at").notNull(), reportedAt: integer("reported_at"),
}, table => [index("feishu_watch_events_owner").on(table.userId, table.watchId, table.observedAt)]);

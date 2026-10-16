CREATE TABLE `feishu_mcp_oauth_access` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feishu_mcp_oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feishu_mcp_oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`challenge` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feishu_mcp_oauth_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `feishu_mcp_oauth_refresh` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`rotation_id` text
);
--> statement-breakpoint
CREATE TABLE `feishu_mcp_oauth_requests` (
	`request_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`challenge` text NOT NULL,
	`state` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`csrf_hash` text NOT NULL,
	`expires_at` integer NOT NULL
);

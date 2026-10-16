CREATE TABLE `feishu_write_operations` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`payload_hash` text NOT NULL,
	`claim` text NOT NULL,
	`status` text NOT NULL,
	`encrypted_result` text,
	`created_at` integer NOT NULL
);

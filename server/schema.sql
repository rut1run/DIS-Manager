CREATE TABLE `bot_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discord_connections` (
	`owner` text PRIMARY KEY NOT NULL,
	`discord_id` text NOT NULL,
	`username` text NOT NULL,
	`tokens` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_panels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`active` text,
	`message_id` text,
	`updated_at` integer NOT NULL,
	`publish_lock` integer DEFAULT 0 NOT NULL
);

CREATE TABLE `initiative_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`initiative_id` text NOT NULL,
	`task_id` text NOT NULL,
	`topic` text NOT NULL,
	`source_task_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiatives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_initiative_subscriptions_initiative_task` ON `initiative_subscriptions` (`initiative_id`,`task_id`);
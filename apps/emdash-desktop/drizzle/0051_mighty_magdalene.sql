CREATE TABLE `initiative_labels` (
	`initiative_id` text NOT NULL,
	`label` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`initiative_id`, `label`),
	FOREIGN KEY (`initiative_id`) REFERENCES `initiatives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `initiative_label` text;
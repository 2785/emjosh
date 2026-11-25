CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	`done_notice` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_task_dependencies_depends_on` ON `task_dependencies` (`depends_on_task_id`);
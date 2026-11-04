CREATE TABLE `posts` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`title` text DEFAULT '[draft]' NOT NULL
);

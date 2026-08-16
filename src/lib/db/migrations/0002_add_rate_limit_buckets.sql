CREATE TABLE "rate_limit_bucket" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 CREATE TYPE "public"."mcpTransport" AS ENUM('stdio', 'http', 'sse');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"mcpServerId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"transport" "mcpTransport" DEFAULT 'http' NOT NULL,
	"url" text,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_org_slug_unique" ON "mcp_servers" ("organizationId","slug");

DO $$ BEGIN
 ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

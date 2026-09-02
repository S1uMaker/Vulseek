CREATE TABLE IF NOT EXISTS "agent_skills" (
	"skillId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"directoryPath" text NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_org_slug_unique" ON "agent_skills" ("organizationId","slug");

DO $$ BEGIN
 ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

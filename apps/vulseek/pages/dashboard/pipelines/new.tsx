import { createServerSideHelpers } from "@trpc/react-query/server";
import { validateRequest } from "@vulseek/server/lib/auth";
import { Workflow } from "lucide-react";
import type {
	GetServerSidePropsContext,
	InferGetServerSidePropsType,
} from "next";
import { useRouter } from "next/router";
import * as React from "react";
import { toast } from "sonner";
import superjson from "superjson";
import {
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
} from "@/components/dashboard/ui-system";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

export const getServerSideProps = async (
	context: GetServerSidePropsContext,
) => {
	const { user, session } = await validateRequest(context.req);
	if (!user || !session) {
		return { redirect: { destination: "/login", permanent: false } };
	}
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			session,
			user,
			req: context.req,
			res: context.res,
			db: undefined,
		} as never,
		transformer: superjson,
	});
	await helpers.pipeline.listVersions
		.prefetch({ pipelineId: "__none__" })
		.catch(() => {});
	return {
		props: { trpcState: helpers.dehydrate() },
	};
};

const NewPipelinePage = (
	_: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const router = useRouter();
	const create = api.pipeline.create.useMutation();
	const templates = api.pipeline.templates.useQuery();

	const [slug, setSlug] = React.useState("");
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [initialYaml, setInitialYaml] = React.useState("");

	// The create form lives purely in local state; warn before losing a
	// half-written pipeline.
	const hasInput =
		slug.trim() !== "" ||
		name.trim() !== "" ||
		description.trim() !== "" ||
		initialYaml.trim() !== "";
	React.useEffect(() => {
		const handler = (event: BeforeUnloadEvent) => {
			if (!hasInput) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [hasInput]);

	const createFromScratch = async () => {
		if (!slug.trim() || !name.trim()) {
			toast.error("A slug and name are required");
			return;
		}
		try {
			const created = await create.mutateAsync({
				slug: slug.trim(),
				name: name.trim(),
				description: description.trim() || null,
				initialYaml: initialYaml.trim() || null,
			});
			toast.success("Pipeline created");
			void router.push(`/dashboard/pipelines/${created.pipelineId}`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to create pipeline",
			);
		}
	};

	const loadBuiltinTemplate = (
		slug: "full" | "delta" | "research" | "tob-goal",
	) => {
		const template = templates.data?.find((item) => item.slug === slug);
		if (!template) {
			toast.error("Template not loaded yet — try again");
			return;
		}
		setSlug(`${slug}-copy`);
		setName(template.name);
		setInitialYaml(template.yaml);
		toast.info("Template loaded — adjust the slug/name and create");
	};

	return (
		<DashboardLayout hideBreadcrumb>
			<BreadcrumbSidebar
				list={[
					{ name: "Pipelines", href: "/dashboard/pipelines" },
					{ name: "New pipeline" },
				]}
			/>
			<DashboardPage>
				<DashboardPageHeader
					icon={<Workflow />}
					title="New pipeline"
					description="Start from scratch, paste YAML, or copy a built-in template"
					actions={
						<Button
							onClick={() => void createFromScratch()}
							disabled={create.isLoading}
						>
							Create pipeline
						</Button>
					}
				/>
				<DashboardPageBody>
					<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
						<Card>
							<CardHeader>
								<CardTitle>Details</CardTitle>
								<CardDescription>
									The slug is permanent and URL-safe; the name can change later.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="space-y-1">
										<Label>Slug</Label>
										<Input
											value={slug}
											onChange={(event) =>
												setSlug(
													event.target.value
														.toLowerCase()
														.replace(/[^a-z0-9_-]/g, "-"),
												)
											}
											placeholder="my-pipeline"
										/>
									</div>
									<div className="space-y-1">
										<Label>Name</Label>
										<Input
											value={name}
											onChange={(event) => setName(event.target.value)}
											placeholder="My Pipeline"
										/>
									</div>
								</div>
								<div className="space-y-1">
									<Label>Description</Label>
									<Input
										value={description}
										onChange={(event) => setDescription(event.target.value)}
										placeholder="Optional"
									/>
								</div>
								<div className="space-y-1">
									<Label>Initial YAML (optional)</Label>
									<Textarea
										rows={10}
										value={initialYaml}
										onChange={(event) => setInitialYaml(event.target.value)}
										placeholder={"version: 3\nname: my-pipeline\n# …"}
										className="font-mono text-xs"
									/>
									<p className="text-xs text-muted-foreground">
										Paste a V3 pipeline document to start from it. Invalid YAML
										can still be saved as a draft.
									</p>
								</div>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Start from a built-in</CardTitle>
								<CardDescription>
									Load a built-in template into the YAML box, then rename and
									create your copy.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-2">
								{(
									[
										["full", "Full scan"],
										["delta", "Delta scan"],
										["research", "Security research"],
										["tob-goal", "ToB goal"],
									] as const
								).map(([key, label]) => (
									<Button
										key={key}
										variant="outline"
										className="w-full justify-start"
										onClick={() => loadBuiltinTemplate(key)}
									>
										{label}
									</Button>
								))}
							</CardContent>
						</Card>
					</div>
				</DashboardPageBody>
			</DashboardPage>
		</DashboardLayout>
	);
};

export default NewPipelinePage;

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__test__/**/*.test.{ts,tsx}"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/.docker/**"],
		pool: "forks",
		// Component tests render with @testing-library/react in jsdom;
		// plain Node tests keep the default node environment.
		environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
		setupFiles: ["__test__/react/setup.ts"],
	},
	define: {
		"process.env": {
			NODE: "test",
		},
	},
	resolve: {
		alias: [
			{
				find: "@",
				replacement: path.resolve(__dirname, ".."),
			},
			{
				find: /^@vulseek\/server\/(.*)$/,
				replacement: `${path.resolve(__dirname, "../../../packages/server/src")}/$1`,
			},
			{
				find: /^@vulseek\/server$/,
				replacement: path.resolve(__dirname, "../../../packages/server/src"),
			},
		],
	},
});

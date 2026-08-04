import { z } from "zod";

export const visibilityInputSchema = z.object({
  url: z.string().trim().min(3, "Enter your website.")
    .transform((value) => /^https?:\/\//i.test(value) ? value : `https://${value}`)
    .pipe(z.string().url("Enter a valid website, such as example.com.")),
  email: z.string({ required_error: "Enter your email so we can send your report." }).trim().email("Enter a valid email so we can send your report.").max(200),
});

export type VisibilityInput = z.infer<typeof visibilityInputSchema>;

export type CategoryScore = { name: string; score: number; findings: string[] };
export type VisibilityReport = {
  score: number;
  categories: CategoryScore[];
  recommendations: { title: string; why: string; fix: string }[];
  summary: string;
};

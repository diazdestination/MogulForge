import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const routes: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/revenue-rescue", priority: 0.9, changeFrequency: "weekly" },
  { path: "/ai-visibility", priority: 0.9, changeFrequency: "weekly" },
  { path: "/revenue-rescue/calculator", priority: 0.8, changeFrequency: "monthly" },
  { path: "/revenue-rescue/demo", priority: 0.8, changeFrequency: "monthly" },
  { path: "/revenue-rescue/scan", priority: 0.8, changeFrequency: "monthly" },
  { path: "/revenue-rescue/install", priority: 0.6, changeFrequency: "monthly" },
  { path: "/revenue-rescue/integrations", priority: 0.6, changeFrequency: "monthly" },
  { path: "/services", priority: 0.7, changeFrequency: "monthly" },
  { path: "/about", priority: 0.5, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.7, changeFrequency: "monthly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: `${SITE_URL}${route.path === "/" ? "" : route.path}`,
    priority: route.priority,
    changeFrequency: route.changeFrequency,
  }));
}

/** Read-only native Item/BOM context; recorded guarantees never come from a recipe calculation. */
export type FeedAnalysis = Record<string, number | null>;
export interface FeedDetails {
	item: string;
	item_name: string;
	animals?: string;
	bom?: string | null;
	recipe_lb?: number | null;
	composition?: Array<{ item_code: string; item_name: string; lbs: number | null; share_pct: number | null; qty?: number; uom?: string }>;
	guaranteed_analysis?: FeedAnalysis;
	guaranteed_analysis_source?: string;
	reference_analysis?: FeedAnalysis;
	reference_analysis_sources?: Record<string, string>;
	calculated_analysis?: FeedAnalysis;
	analysis_missing_items?: Record<string, string[]>;
	nutrient_labels?: Record<string, string>;
	original_run?: { pounds: number | null; bags: number | null };
}
export interface FeedOrderComparison {
	note?: string | null;
	bom: string;
	ingredients: Array<{ item_code: string; item_name: string; recipe_lb: number; planned_lb: number }>;
	recipe_analysis: FeedAnalysis;
	planned_analysis: FeedAnalysis;
}

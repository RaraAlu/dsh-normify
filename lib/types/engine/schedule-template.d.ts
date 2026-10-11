import type { SchedulePlan } from './schedule.js';
import type { RenderSummary } from './template.js';
/** 自包含排程查看器；不加载脚本包，也不执行源数据。 */
export declare function renderScheduleTemplate(plan: SchedulePlan, summary: RenderSummary, opts?: {
    lang?: string;
    theme?: string;
    live?: boolean;
    contentHash?: string;
    nonce?: string;
}): string;

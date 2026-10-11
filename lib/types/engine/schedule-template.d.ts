import type { SchedulePlan } from './schedule.js';
import type { RenderSummary } from './template.js';
/** 自包含画布。源数据只作文本，不进入脚本源码。 */
export declare function renderScheduleTemplate(plan: SchedulePlan, summary: RenderSummary, opts?: {
    lang?: string;
    theme?: string;
    live?: boolean;
    contentHash?: string;
    nonce?: string;
}): string;

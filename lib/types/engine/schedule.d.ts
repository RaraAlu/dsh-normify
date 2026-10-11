import type { ChangeData, ChangeStatus, Diagnostic, LocalizedText, ModuleFile } from './types.js';
export type ScheduleReadiness = 'ready' | 'blocked' | 'in_progress' | 'verified' | 'abandoned' | 'unscheduled';
export interface ScheduleTask {
    id: string;
    title: LocalizedText;
    status: ChangeStatus;
    phase?: string;
    owner?: string;
    depends_on: string[];
    modules: string[];
    files: string[];
    resources: string[];
    priority: number;
    readiness: ScheduleReadiness;
    blockers: string[];
}
export interface ScheduleConflict {
    left: string;
    right: string;
    modules: string[];
    files: string[];
    resources: string[];
}
export interface SchedulePlan {
    schema_version: 1;
    ok: boolean;
    tasks: ScheduleTask[];
    ready: string[];
    running: string[];
    blocked: string[];
    unscheduled: string[];
    completed: string[];
    waves: string[][];
    conflicts: ScheduleConflict[];
    errors: Diagnostic[];
    warnings: Diagnostic[];
    mermaid: string;
}
/** L1 保持 v1 兼容；只有显式 schedule 才进入排程。 */
export declare function l1ValidateSchedule(value: unknown, id: string): Diagnostic[];
/** 不从架构箭头推导开发顺序。不为未登记任务承诺并行安全。 */
export declare function buildSchedule(changes: ChangeData[], byId?: Map<string, ModuleFile>): SchedulePlan;
export declare function loadSchedulePlan(projectDir: string): Promise<SchedulePlan>;
/** 在持久化前检查候选；MCP 负责目录锁，直接调用者须自行串行化。 */
export declare function checkScheduledChange(projectDir: string, candidate: ChangeData): Promise<Diagnostic[]>;
export declare function renderScheduleMarkdown(plan: SchedulePlan): string;

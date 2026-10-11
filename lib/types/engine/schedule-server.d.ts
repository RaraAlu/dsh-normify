interface ViewerOptions {
    lang?: string;
    theme?: string;
}
export interface ScheduleViewerOutput {
    url: string;
    bytes: number;
    sha256: null;
    summary: Record<string, unknown>;
}
/** 同一进程与真实项目路径复用URL；响应始终重读源数据。 */
export declare function openScheduleViewer(projectDir: string, options?: ViewerOptions): Promise<ScheduleViewerOutput>;
/** 供进程收尾与测试使用；不增加MCP工具。 */
export declare function closeScheduleViewer(): Promise<void>;
export {};

import type { Diagnostic } from './types.js';
export interface RenderOptions {
    out?: string;
    lang?: string;
    theme?: string;
    view?: 'architecture' | 'schedule';
}
export interface RenderOutput {
    ok: boolean;
    htmlPath: string | null;
    url?: string;
    bytes: number;
    sha256: string | null;
    summary: Record<string, unknown> | null;
    errors: Diagnostic[];
    warnings: Diagnostic[];
}
/** 架构保留文件输出；实时排程只返回本地能力URL。 */
export declare function renderProject(projectDir: string, opts: RenderOptions): Promise<RenderOutput>;

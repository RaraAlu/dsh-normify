import type { Diagnostic, Module, ModuleFile, SourceRef } from './types.js';
export declare const PROJECT_PREFIX = "normify-";
export declare class NormifyError extends Error {
    code: string;
    constructor(code: string, message: string);
}
export interface ProjectRef {
    dir: string;
    slug: string;
}
/** 只计算项目位置。该函数不读取或创建目录。 */
export declare function locateProject(rootDir: string, args: {
    project?: string;
    dir?: string;
}): ProjectRef;
/** 写工具可创建项目。定位规则沿用纯函数。 */
export declare function resolveProject(rootDir: string, args: {
    project?: string;
    dir?: string;
}, opts?: {
    create?: boolean;
}): Promise<ProjectRef>;
export declare function listProjects(rootDir: string): ProjectRef[];
/** 排程采用严格读取，避免遗漏占用模块。 */
export declare function listModuleFiles(projectDir: string, strict?: boolean): Promise<string[]>;
/** 找模块现有文件（容器 index.md 优先，其次叶子 x.md）。 */
export declare function findModuleFile(projectDir: string, id: string): string | null;
export declare function loadAllModules(projectDir: string, strict?: boolean): Promise<{
    files: ModuleFile[];
    errors: Diagnostic[];
    warnings: Diagnostic[];
}>;
/** 判断某模块当前是否为容器（有子模块或是根）。 */
export declare function isContainer(module: Module, all: Module[]): boolean;
export declare function writeModuleFile(projectDir: string, module: Module, body: string): Promise<{
    file: string;
    promoted: string[];
    warnings: Diagnostic[];
}>;
/** 删除模块及其子树（含空目录清理与父模块降级）。 */
export declare function deleteModuleTree(projectDir: string, id: string): Promise<{
    deleted: string[];
    demoted: string | null;
    warnings: Diagnostic[];
}>;
/** 叶子晋升容器：x.md → x/index.md。 */
export declare function promoteModule(projectDir: string, id: string): Promise<{
    file: string;
    warnings: Diagnostic[];
}>;
/** 仓库当前 HEAD（40 位 SHA）。 */
export declare function gitHead(repoRoot: string): {
    sha: string | null;
    error: string | null;
};
/** git 变更文件清单（增量再生成的输入）。 */
export declare function gitChangedFiles(repoRoot: string, diffSpec: string): {
    files: string[] | null;
    error: string | null;
};
/** source 文件集合的 SHA-256 指纹（全量哈希，v1 不做采样）。 */
export declare function fingerprintOf(repoRoot: string, sources: SourceRef[]): Promise<{
    hash: string | null;
    missing: string[];
}>;
export declare function sha256Text(text: string): string;

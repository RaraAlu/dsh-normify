export interface ToolEnv {
    rootDir: string;
    requireBilingual: boolean;
}
/** JSON Schema 节点（作者态：属性级内联 required: true；编译后对象级为 required: string[]）。 */
interface SchemaNode {
    type?: string;
    description?: string;
    required?: boolean | string[];
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    additionalProperties?: boolean;
    [key: string]: unknown;
}
/** params() 编译出的对象级 JSON Schema。 */
type ObjectSchema = SchemaNode & {
    required?: string[];
};
/** 工具行为标记：read=只读；write=写入；destroy=破坏性；idempotent=幂等。 */
type ToolBehavior = 'read' | 'write' | 'destroy' | 'idempotent';
/** 宿主无关的工具注册接口。 */
interface ToolService {
    register?: (def: ToolRegistration) => void;
}
/** 工具注册接口不依赖宿主。 */
export interface ToolContext {
    tools?: ToolService;
}
/** 交给 tools.register 的注册对象。 */
interface ToolRegistration {
    name: string;
    description: string;
    behavior: ToolBehavior;
    parameters?: ObjectSchema;
    readOnly: boolean;
    idempotent: boolean;
    destructive: boolean;
    output: {
        schema: Record<string, unknown>;
        render: (args: Record<string, unknown>, value: unknown) => {
            type: string;
            text: string | undefined;
        }[];
    };
    execute: (args: Record<string, unknown>) => Promise<unknown>;
    isConcurrencySafe?: () => boolean;
}
export declare function registerTools(ctx: ToolContext, env: ToolEnv): void;
export {};

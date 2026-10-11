interface Point {
    x: number;
    y: number;
}
interface NodeSize {
    width: number;
    height: number;
}
interface Obstacle extends Point {
    id: string;
}
/** 同尺寸节点沿拓扑层横排。行间空隙须至少32px。 */
export declare function prerequisitePath(from: Point, to: Point, size: NodeSize, obstacles: readonly Obstacle[], exclude: readonly string[], outsideX: number): string;
export {};

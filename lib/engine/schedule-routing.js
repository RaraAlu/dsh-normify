/** 同尺寸节点沿拓扑层横排。行间空隙须至少32px。 */
export function prerequisitePath(from, to, size, obstacles, exclude, outsideX) {
    const x1 = from.x + size.width / 2, x2 = to.x + size.width / 2;
    const y1 = from.y + size.height, y2 = to.y;
    const mid = (y1 + y2) / 2;
    const excluded = new Set(exclude);
    // 给连线留4px间距。检查圆角路线的保守直角包络。
    const blocked = (a, b) => obstacles.some(node => {
        if (excluded.has(node.id))
            return false;
        return Math.max(Math.min(a.x, b.x), node.x - 4) <= Math.min(Math.max(a.x, b.x), node.x + size.width + 4)
            && Math.max(Math.min(a.y, b.y), node.y - 4) <= Math.min(Math.max(a.y, b.y), node.y + size.height + 4);
    });
    if (blocked({ x: x1, y: y1 }, { x: x1, y: mid })
        || blocked({ x: x1, y: mid }, { x: x2, y: mid })
        || blocked({ x: x2, y: mid }, { x: x2, y: y2 })) {
        // 两端在行间横移。外侧通道须超出全部节点，且计入画布宽度。
        const gap = Math.min(16, (y2 - y1) / 4);
        return 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + (y1 + gap)
            + ' L ' + outsideX + ' ' + (y1 + gap) + ' L ' + outsideX + ' ' + (y2 - gap)
            + ' L ' + x2 + ' ' + (y2 - gap) + ' L ' + x2 + ' ' + y2;
    }
    if (x1 === x2)
        return 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2;
    const sign = Math.sign(x2 - x1);
    const bend = Math.min(8, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 4);
    return 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + (mid - bend)
        + ' Q ' + x1 + ' ' + mid + ' ' + (x1 + sign * bend) + ' ' + mid
        + ' L ' + (x2 - sign * bend) + ' ' + mid
        + ' Q ' + x2 + ' ' + mid + ' ' + x2 + ' ' + (mid + bend)
        + ' L ' + x2 + ' ' + y2;
}
//# sourceMappingURL=schedule-routing.js.map
/**
 * 合并两个数组。
 *
 * 用泛型而非 any，让调用方能拿到准确的元素类型推断；
 * 用 readonly 约束入参，避免函数内部改动调用方的原始数组。
 */
export function mergeArrays<T>(a: readonly T[], b: readonly T[]): T[] {
  // 用展开运算符生成新数组，而不是 a.push(...b)，保证原数组不被修改
  return [...a, ...b]
}

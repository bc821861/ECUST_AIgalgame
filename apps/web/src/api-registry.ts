/** 注册表（属性声明）：图鉴/面板按数据渲染，不在前端硬编码属性键（I2）。 */
import { request, unwrap } from "./http.ts";

export interface AttrDecl {
  key: string;
  type: string;
  scope: string[];
  min?: number;
  max?: number;
  visibility: "public" | "self" | "secret";
  label: string;
  unit?: string;
  hidden: boolean;
}

export async function getRegistry(): Promise<AttrDecl[]> {
  const res = await request<{ attrs: AttrDecl[] }>("registry", "/api/v1/registry");
  return unwrap(res).attrs;
}

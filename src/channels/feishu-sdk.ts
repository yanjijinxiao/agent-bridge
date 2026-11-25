import { AsyncLocalStorage } from "node:async_hooks";
import * as Lark from "@larksuiteoapi/node-sdk";
import { assertFeishuSuccess } from "./feishu-result.js";

// The SDK response interceptor unwraps AxiosResponse.data at runtime, while
// defaultHttpInstance retains Axios' declared wrapper type.
type FeishuHttp = NonNullable<ConstructorParameters<typeof Lark.Client>[0]["httpInstance"]>;

// The generated SDK resource method does not expose Axios cancellation.
// Carry this download's deadline to the resource download. Token refresh can be shared by other operations.
export const feishuDownloadSignal = new AsyncLocalStorage<AbortSignal>();

/** file/image.create unwraps response.data, discarding the business status.
 * Validate the raw envelope on this account's transport before that happens;
 * never mutate the SDK's global HTTP interceptors shared by other accounts. */
export function createFeishuApiClient(config: { appId: string; appSecret: string }, transport: FeishuHttp = Lark.defaultHttpInstance as unknown as FeishuHttp): Lark.Client {
  return new Lark.Client({ ...config, httpInstance: {
    ...transport,
    async request(options) {
      const signal = feishuDownloadSignal.getStore();
      const resourceGet = options.method?.toUpperCase() === "GET" && /\/im\/v1\/messages\/[^/]+\/resources\//.test(options.url ?? "");
      const request = signal && resourceGet ? { ...options, signal } : options;
      const result = await transport.request(request);
      if (options.method?.toUpperCase() === "POST" && /\/open-apis\/im\/v1\/(?:files|images)(?:\?|$)/.test(options.url ?? "")) {
        assertFeishuSuccess(result, options.url!.includes("/images") ? "uploadImage" : "uploadFile");
      }
      return result;
    }
  } });
}

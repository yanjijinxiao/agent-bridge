import * as Lark from "@larksuiteoapi/node-sdk";
import { assertFeishuSuccess } from "./feishu-result.js";

// The SDK response interceptor unwraps AxiosResponse.data at runtime, while
// defaultHttpInstance retains Axios' declared wrapper type.
type FeishuHttp = NonNullable<ConstructorParameters<typeof Lark.Client>[0]["httpInstance"]>;

/** file/image.create unwraps response.data, discarding the business status.
 * Validate the raw envelope on this account's transport before that happens;
 * never mutate the SDK's global HTTP interceptors shared by other accounts. */
export function createFeishuApiClient(config: { appId: string; appSecret: string }, transport: FeishuHttp = Lark.defaultHttpInstance as unknown as FeishuHttp): Lark.Client {
  return new Lark.Client({ ...config, httpInstance: {
    ...transport,
    async request(options) {
      const result = await transport.request(options);
      if (options.method?.toUpperCase() === "POST" && /\/open-apis\/im\/v1\/(?:files|images)(?:\?|$)/.test(options.url ?? "")) {
        assertFeishuSuccess(result, options.url!.includes("/images") ? "uploadImage" : "uploadFile");
      }
      return result;
    }
  } });
}

import worker from "../../cloud/src/index.mjs";

// Inject a transport failure around the real D1 operation, not a fake database.
export default {
  async fetch(request, env) {
    const mode = request.headers.get("x-audit-fault");
    if (!mode) return worker.fetch(request, env);
    const database = {
      prepare(sql) {
        const wrap = statement => new Proxy(statement, {
          get(target, key) {
            if (key === "bind") return (...args) => wrap(target.bind(...args));
            if (key === "run" && /INSERT INTO attachments/.test(sql)) return async () => {
              if (mode !== "before") await target.run();
              throw new Error("injected D1 acknowledgement loss");
            };
            if (key === "first" && mode === "read-unavailable" && /FROM attachments/.test(sql)) {
              return async () => { throw new Error("injected D1 read unavailable"); };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return wrap(env.DB.prepare(sql));
      },
      batch: (...args) => env.DB.batch(...args),
    };
    return worker.fetch(request, { ...env, DB: database });
  },
};

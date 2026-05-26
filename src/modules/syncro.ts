import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

const SYNCRO_API_URL = process.env.SYNCRO_API_URL || "";
const SYNCRO_API_KEY = process.env.SYNCRO_API_KEY || "";

const MAX_REQUESTS_PER_MIN = 180;
const WINDOW_MS = 60_000;
const MAX_WAIT_MS = 30_000;

class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly max: number, private readonly windowMs: number, private readonly maxWaitMs: number) {}

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      const prune = () => {
        const cutoff = Date.now() - this.windowMs;
        this.timestamps = this.timestamps.filter((t) => t > cutoff);
      };

      prune();
      if (this.timestamps.length >= this.max) {
        const waitMs = this.timestamps[0] + this.windowMs - Date.now() + 25;
        if (waitMs > this.maxWaitMs) {
          throw new Error(
            `Rate limit excedido (${this.max} req/min). Espera estimada ${Math.ceil(waitMs / 1000)}s supera el máximo de ${Math.ceil(this.maxWaitMs / 1000)}s. Reintentá en unos segundos.`
          );
        }
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        prune();
      }
      this.timestamps.push(Date.now());
    });
    this.chain = next.catch(() => {});
    return next;
  }

  status() {
    const cutoff = Date.now() - this.windowMs;
    const recent = this.timestamps.filter((t) => t > cutoff).length;
    return { recent, max: this.max, windowMs: this.windowMs };
  }
}

const limiter = new SlidingWindowRateLimiter(MAX_REQUESTS_PER_MIN, WINDOW_MS, MAX_WAIT_MS);

export interface SyncroConfig {
  schema_description: string;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const base = baseUrl.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${cleanPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((val) => url.searchParams.append(k, String(val)));
      else url.searchParams.append(k, String(v));
    }
  }
  return url.toString();
}

export function registrarModuloSyncro(
  server: McpServer,
  usuario: string,
  config: SyncroConfig,
  tienePermiso: boolean
) {
  const MSG_SIN_PERMISO = "No tenés permisos para consultar la API de Syncro. Si creés que deberías tener acceso, contactá a un administrador.";

  server.tool(
    "syncro_consulta",
    `Consulta de solo lectura (GET) contra la API REST de Syncro MSP (https://api-docs.syncromsp.com).
Usá esta herramienta para responder preguntas abiertas sobre tickets, clientes, contactos, contratos, activos, facturas, presupuestos, pagos, RMM alerts, agendas, productos, órdenes de compra, etc.

== SOLO LECTURA ==
Esta tool ejecuta exclusivamente requests HTTP GET. No permite crear, modificar ni borrar nada en Syncro.

== AUTH Y RATE LIMIT ==
- El servidor inyecta el header Authorization: Bearer <SYNCRO_API_KEY>. No incluyas credenciales en la query.
- Hay un rate limiter global de ${MAX_REQUESTS_PER_MIN} requests/min compartido entre TODOS los usuarios del MCP (la API limita 180/min por IP).
- Si el rate está saturado, la tool espera hasta ${Math.ceil(MAX_WAIT_MS / 1000)}s y, si la espera estimada supera ese máximo, devuelve error. Espaciá tus consultas.

== USO ==
Pasá path y opcionalmente query:
- path: el path relativo del endpoint, ej. "/tickets", "/customers/123", "/invoices". Sin el prefijo del host.
- query: objeto plano con los query params, ej. { page: 1, query: "juan", customer_id: 123 }.

== PAGINACIÓN ==
La mayoría de los listados de Syncro paginan con ?page=N (25 por página por defecto). Para barrer todo iterá page=1, 2, ... hasta que vuelva vacío. Filtrá con query params antes de paginar.

== TIPS ==
- Para buscar por texto libre usá /search (parámetro ?query=...) o el ?query= disponible en muchos listados.
- IDs son enteros. Las fechas se devuelven en ISO 8601.
- Si el path tiene segmentos parametrizados (ej. /customers/{customer_id}/phones), reemplazá las llaves por el id concreto antes de llamar.

${config.schema_description}`,
    {
      path: z
        .string()
        .describe('Path relativo del endpoint, ej. "/tickets" o "/customers/123". No incluir host ni "api/v1".'),
      query: z
        .record(z.unknown())
        .optional()
        .describe("Objeto con los query params. Opcional."),
    },
    async ({ path, query }) => {
      if (!tienePermiso) return { content: [{ type: "text", text: MSG_SIN_PERMISO }] };

      if (!SYNCRO_API_URL || !SYNCRO_API_KEY) {
        return {
          content: [{ type: "text", text: "Error: SYNCRO_API_URL o SYNCRO_API_KEY no están configuradas en el servidor." }],
          isError: true,
        };
      }

      let url: string;
      try {
        url = buildUrl(SYNCRO_API_URL, path, query);
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error armando URL: ${err.message}` }], isError: true };
      }

      try {
        await limiter.acquire();
      } catch (err: any) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }

      console.log(`[SYNCRO] ${usuario} → GET ${url}`);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${SYNCRO_API_KEY}`,
            Accept: "application/json",
          },
        });
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error de red: ${err.message}` }], isError: true };
      }

      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // se queda como texto crudo
      }

      const limStatus = limiter.status();
      const payload = {
        status: response.status,
        ok: response.ok,
        rate_limit: `${limStatus.recent}/${limStatus.max} en último minuto`,
        data: parsed,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError: !response.ok,
      };
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as dotenv from "dotenv";
import { obtenerTokenBC, invalidarTokenBC } from "../auth.js";

dotenv.config();

const TENANT_ID = process.env.AZURE_TENANT_ID!;
const BC_ENVIRONMENT = process.env.BC_ENVIRONMENT!;
const BC_COMPANY_ID = process.env.BC_COMPANY_ID ?? "";

const BC_BASE = `https://api.businesscentral.dynamics.com/v2.0/${TENANT_ID}/${BC_ENVIRONMENT}/api/v2.0`;

const ENTIDADES_PERMITIDAS = new Set([
  // Documentos de venta
  "salesInvoices",
  "salesInvoiceLines",
  "salesOrders",
  "salesOrderLines",
  "salesQuotes",
  "salesQuoteLines",
  "salesCreditMemos",
  "salesCreditMemoLines",
  // Clientes / vendedores
  "customers",
  "customerSalesHistory",
  "customerPaymentJournals",
  "customerFinancialDetails",
  "agedAccountsReceivable",
  "salespeople",
  // Productos / catálogos
  "items",
  "itemCategories",
  "unitsOfMeasure",
  // Análisis transversal
  "dimensions",
  "dimensionValues",
  "dimensionLines",
  "generalLedgerEntries",
  // Catálogos comerciales
  "paymentTerms",
  "paymentMethods",
  "currencies",
  "taxGroups",
  "taxAreas",
  "shipmentMethods",
  "countriesRegions",
  // Meta
  "companies",
]);

export interface VentasConfig {
  schema_description: string;
}

async function bcGet(usuario: string, path: string, query?: Record<string, string>): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const url = new URL(`${BC_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }

  const fetchOnce = async (token: string) => {
    console.log(`[BC-VENTAS] ${usuario} → GET ${url.toString()}`);
    return fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  };

  let token = await obtenerTokenBC(usuario);
  if (!token) return { ok: false, status: 401, body: "no_token" };

  let resp = await fetchOnce(token);
  if (resp.status === 401) {
    invalidarTokenBC(usuario);
    token = await obtenerTokenBC(usuario);
    if (!token) return { ok: false, status: 401, body: "no_token" };
    resp = await fetchOnce(token);
  }

  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, status: resp.status, body };
  }
  return { ok: true, data: await resp.json() };
}

export function registrarModuloVentas(
  server: McpServer,
  usuario: string,
  config: VentasConfig,
  tienePermiso: boolean
) {
  const MSG_SIN_PERMISO = "No tenés permisos para consultar información de ventas. Si creés que deberías tener acceso, contactá a un administrador.";
  const MSG_SIN_TOKEN = "Tu sesión no incluye permisos para Business Central. Cerrá sesión en el MCP y volvé a iniciar para autorizar el acceso a BC.";

  server.tool(
    "ventas_listar_companias",
    `Lista las compañías disponibles en Business Central (prod) para el usuario actual.
Útil al inicio para identificar el GUID de la compañía a la que apuntar (BC_COMPANY_ID).`,
    {},
    async () => {
      if (!tienePermiso) return { content: [{ type: "text", text: MSG_SIN_PERMISO }] };

      const result = await bcGet(usuario, "/companies");
      if (!result.ok) {
        if (result.body === "no_token") return { content: [{ type: "text", text: MSG_SIN_TOKEN }], isError: true };
        return { content: [{ type: "text", text: `Error BC ${result.status}: ${result.body}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
    }
  );

  server.tool(
    "ventas_consulta_odata",
    `Consulta de solo lectura contra la API OData v2.0 de Business Central, scopeada a la compañía configurada en BC_COMPANY_ID.
Usá esta herramienta para obtener facturas de venta, órdenes de venta, presupuestos, notas de crédito, clientes, ítems, etc.

== ENTIDADES PERMITIDAS ==
${[...ENTIDADES_PERMITIDAS].join(", ")}

Cualquier otra entidad será rechazada.

== EJEMPLOS DE FILTROS ($filter) ==
- Facturas posteriores a una fecha: invoiceDate gt 2026-01-01
- Cliente por nombre parcial: contains(displayName, 'Acme')
- Combinación: invoiceDate gt 2026-01-01 and totalAmountIncludingTax gt 100000

${config.schema_description}`,
    {
      entidad: z.string().describe("Nombre del entity set OData (ej: salesInvoices, customers)."),
      filter: z.string().optional().describe("Cláusula OData $filter."),
      select: z.string().optional().describe("Cláusula OData $select (columnas separadas por coma)."),
      top: z.number().int().positive().max(500).optional().describe("Cantidad máxima de filas (default 100, máx 500)."),
      expand: z.string().optional().describe("Cláusula OData $expand."),
      orderby: z.string().optional().describe("Cláusula OData $orderby (ej: invoiceDate desc)."),
    },
    async ({ entidad, filter, select, top, expand, orderby }) => {
      if (!tienePermiso) return { content: [{ type: "text", text: MSG_SIN_PERMISO }] };

      if (!ENTIDADES_PERMITIDAS.has(entidad)) {
        return { content: [{ type: "text", text: `Error: entidad no permitida. Permitidas: ${[...ENTIDADES_PERMITIDAS].join(", ")}` }], isError: true };
      }
      if (!BC_COMPANY_ID) {
        return { content: [{ type: "text", text: "Error: BC_COMPANY_ID no está configurado en el server. Llamá a ventas_listar_companias y pedile al admin que lo cargue en .env." }], isError: true };
      }

      const path = entidad === "companies"
        ? "/companies"
        : `/companies(${BC_COMPANY_ID})/${entidad}`;

      const query: Record<string, string> = {};
      if (filter) query["$filter"] = filter;
      if (select) query["$select"] = select;
      query["$top"] = String(top ?? 100);
      if (expand) query["$expand"] = expand;
      if (orderby) query["$orderby"] = orderby;

      const result = await bcGet(usuario, path, query);
      if (!result.ok) {
        if (result.body === "no_token") return { content: [{ type: "text", text: MSG_SIN_TOKEN }], isError: true };
        return { content: [{ type: "text", text: `Error BC ${result.status}: ${result.body}` }], isError: true };
      }
      const data = result.data;
      const filas = Array.isArray(data?.value) ? data.value.length : undefined;
      return { content: [{ type: "text", text: JSON.stringify(filas !== undefined ? { filas, datos: data.value } : data) }] };
    }
  );
}

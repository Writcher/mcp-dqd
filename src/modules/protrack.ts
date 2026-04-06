import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import mysql from "mysql2/promise";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

const dbConfig: mysql.ConnectionOptions = {
  host: process.env.MYSQL_HOST!,
  port: parseInt(process.env.MYSQL_PORT || "3306"),
  database: process.env.MYSQL_DATABASE!,
  user: process.env.MYSQL_USER!,
  password: process.env.MYSQL_PASSWORD!,
};

async function getConnection() {
  return mysql.createConnection(dbConfig);
}

export interface ProtrackConfig {
  schema_description: string;
}

export function registrarModuloProtrack(
  server: McpServer,
  usuario: string,
  config: ProtrackConfig,
  tienePermiso: boolean
) {
  const MSG_SIN_PERMISO = "No tenés permisos para consultar información de Protrack. Si creés que deberías tener acceso, contactá a un administrador.";

  server.tool(
    "protrack_consulta",
    `Ejecuta una consulta SELECT de solo lectura contra la base de datos de Protrack (MySQL).
Usá esta herramienta para responder cualquier pregunta sobre activos/vehículos, dispositivos IoT, tracking GPS, mantenimiento (órdenes de trabajo), conductores, geocercas, alertas, combustible, organizaciones, etc.

${config.schema_description}`,
    { query: z.string().describe("Consulta SQL SELECT a ejecutar. Solo se permiten SELECT.") },
    async ({ query }) => {
      if (!tienePermiso) return { content: [{ type: "text", text: MSG_SIN_PERMISO }] };

      const trimmed = query.trim();
      if (!/^SELECT\b/i.test(trimmed)) {
        return { content: [{ type: "text", text: "Error: Solo se permiten consultas SELECT." }], isError: true };
      }
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|DENY)\b/i.test(trimmed)) {
        return { content: [{ type: "text", text: "Error: La consulta contiene operaciones no permitidas." }], isError: true };
      }

      console.log(`[SQL-MySQL] ${usuario} → ${trimmed}`);

      const conn = await getConnection();
      try {
        const [rows] = await conn.query(trimmed);
        const recordset = rows as Record<string, unknown>[];
        return {
          content: [{ type: "text", text: JSON.stringify({ filas: recordset.length, datos: recordset }) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error SQL: ${err.message}` }], isError: true };
      } finally {
        await conn.end();
      }
    }
  );
}

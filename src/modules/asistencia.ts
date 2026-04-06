import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sql from "mssql";
import pg from "pg";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

const dbConfig: sql.config = {
  server: process.env.MSSQL_HOST!,
  port: parseInt(process.env.MSSQL_PORT || "1433"),
  database: process.env.MSSQL_ASISTENCIA_DATABASE!,
  user: process.env.MSSQL_USER!,
  password: process.env.MSSQL_PASSWORD!,
  options: { trustServerCertificate: true },
};

async function getPool() {
  return sql.connect(dbConfig);
}

const pgConfig: pg.PoolConfig = {
  host: process.env.PSQL_DB_HOST!,
  port: parseInt(process.env.PSQL_DB_PORT || "5432"),
  database: process.env.PSQL_DB_DATABASE!,
  user: process.env.PSQL_DB_USERNAME!,
  password: process.env.PSQL_DB_PASSWORD!,
  ssl: { rejectUnauthorized: false },
};

const pgPool = new pg.Pool(pgConfig);

export interface AsistenciaConfig {
  proyectos: Record<string, string[]>;
  schema_description: string;
  jornadas_schema_description: string;
}

export function registrarModuloAsistencia(
  server: McpServer,
  usuario: string,
  config: AsistenciaConfig,
  tienePermiso: boolean
) {
  const MSG_SIN_PERMISO = "No tenés permisos para consultar información de asistencia. Si creés que deberías tener acceso, contactá a un administrador.";
  const proyectos = config.proyectos;
  const schemaDescription = `${config.schema_description}

== MAPEO DISPOSITIVOS → PROYECTO ==
Los dispositivos (relojes) se agrupan por proyecto. Este mapeo NO está en la DB:
${Object.entries(proyectos).map(([k, v]) => `  ${k}: ${v.length ? v.join(", ") : "(sin dispositivos)"}`).join("\n")}`;

  server.tool(
    "listar_proyectos",
    "Lista todos los proyectos de la empresa con sus dispositivos (relojes) asociados.",
    {},
    async () => {
      if (!tienePermiso) return { content: [{ type: "text", text: MSG_SIN_PERMISO }] };
      return { content: [{ type: "text", text: JSON.stringify(config.proyectos, null, 2) }] };
    }
  );

  server.tool(
    "jornadas_consulta",
    `FUENTE SECUNDARIA — Ejecuta una consulta SELECT de solo lectura contra la base de datos de jornadas/horas del sistema de RRHH (PostgreSQL).
Esta base es complementaria a asistencia_consulta. Usala para consultar horas trabajadas, jornadas, horas extra, horas nocturnas, ausencias, quincenas, importaciones de marcas, etc.
IMPORTANTE: Ante discrepancias entre esta base y asistencia_consulta, la fuente autoritativa es asistencia_consulta (SQL Server).

${config.jornadas_schema_description}`,
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

      console.log(`[SQL-PG] ${usuario} → ${trimmed}`);

      try {
        const result = await pgPool.query(trimmed);
        return {
          content: [{ type: "text", text: JSON.stringify({ filas: result.rowCount, datos: result.rows }) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error SQL: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "asistencia_consulta",
    `FUENTE PRINCIPAL / AUTORITATIVA — Ejecuta una consulta SELECT de solo lectura contra la base de datos de asistencia (SQL Server).
Esta es la fuente de verdad para asistencia, presentes, ausentes, empleados, nómina, etc. Ante cualquier discrepancia con jornadas_consulta, prevalece esta base.

${schemaDescription}`,
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

      console.log(`[SQL] ${usuario} → ${trimmed}`);

      const pool = await getPool();
      try {
        const result = await pool.request().query(trimmed);
        await pool.close();
        return {
          content: [{ type: "text", text: JSON.stringify({ filas: result.recordset.length, datos: result.recordset }) }],
        };
      } catch (err: any) {
        await pool.close();
        return { content: [{ type: "text", text: `Error SQL: ${err.message}` }], isError: true };
      }
    }
  );
}

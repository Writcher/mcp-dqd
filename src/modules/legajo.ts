import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sql from "mssql";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

const dbConfig: sql.config = {
  server: process.env.MSSQL_HOST!,
  port: parseInt(process.env.MSSQL_PORT || "1433"),
  database: process.env.MSSQL_LEGAJO_DATABASE!,
  user: process.env.MSSQL_USER!,
  password: process.env.MSSQL_PASSWORD!,
  options: { trustServerCertificate: true },
};

async function getPool() {
  return sql.connect(dbConfig);
}

export interface LegajoConfig {
  schema_description: string;
}

export function registrarModuloLegajo(
  server: McpServer,
  usuario: string,
  config: LegajoConfig,
  tienePermiso: boolean
) {
  const MSG_SIN_PERMISO = "No tenés permisos para consultar información del legajo digital. Si creés que deberías tener acceso, contactá a un administrador.";

  server.tool(
    "legajo_consulta",
    `Ejecuta una consulta SELECT de solo lectura contra la base de datos del legajo digital (SQL Server).
Usá esta herramienta para consultar los datos del formulario de legajo digital que completan tanto empleados como postulantes: datos personales, contacto, domicilio, estudios, experiencia, familiares, documentación adjunta, etc.

== DISTINCIÓN EMPLEADO vs POSTULANTE ==
Ambos cargan el mismo formulario y quedan en dbo.Empleado. La diferencia está en las columnas idArea y puesto:
- Empleado: idArea y puesto COMPLETADOS (NOT NULL / no vacíos).
- Postulante: idArea y puesto SIN COMPLETAR (NULL o vacíos).
Filtrá según corresponda al segmentar la consulta.

== CRUCE CON ASISTENCIA ==
El dni de dbo.Empleado se puede cruzar con dbo.nomina.dni de la base del módulo de asistencia (MSSQL_ASISTENCIA_DATABASE = control_de_accesos) para obtener proyecto, legajo, convenio, fecha de ingreso/egreso, estado, etc. Ese cruce se hace desde el módulo de asistencia; esta herramienta opera solo sobre legajo_digital.

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

      console.log(`[SQL-LEGAJO] ${usuario} → ${trimmed}`);

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

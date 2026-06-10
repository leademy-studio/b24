/**
 * MCP-сервер, отдающий инструменты для работы с Google Cloud и Yandex Cloud.
 *
 * Транспорт: stdio (стандарт для локальных MCP-серверов в Claude Code / VS Code).
 * Запуск в разработке:  npm run mcp:dev
 * Запуск из сборки:     npm run build && npm run mcp:start
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as google from "../cloud/google.js";
import * as yandex from "../cloud/yandex.js";

const server = new McpServer({
  name: "b24-cloud-mcp",
  version: "1.0.0",
});

/** Унифицированный JSON-ответ инструмента. */
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Ошибка: ${message}` }], isError: true };
}

// ─────────────────────────── Google Cloud ───────────────────────────

server.registerTool(
  "gcp_storage_list_buckets",
  {
    title: "GCP: список бакетов",
    description: "Возвращает список бакетов Cloud Storage в проекте GCP.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await google.listBuckets());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "gcp_storage_list_objects",
  {
    title: "GCP: объекты в бакете",
    description: "Возвращает список объектов в указанном бакете Cloud Storage.",
    inputSchema: {
      bucket: z.string().describe("Имя бакета"),
      prefix: z.string().optional().describe("Префикс для фильтрации объектов"),
      maxResults: z.number().int().positive().max(1000).optional().describe("Максимум объектов (по умолчанию 100)"),
    },
  },
  async ({ bucket, prefix, maxResults }) => {
    try {
      return jsonResult(await google.listObjects(bucket, prefix, maxResults));
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ─────────────────────────── Yandex Cloud ───────────────────────────

server.registerTool(
  "yc_list_clouds",
  {
    title: "Yandex Cloud: список облаков",
    description: "Возвращает список облаков (clouds), доступных учётной записи.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await yandex.listClouds());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "yc_list_folders",
  {
    title: "Yandex Cloud: список каталогов",
    description: "Возвращает список каталогов (folders) в облаке. cloudId можно опустить, если задан YC_CLOUD_ID.",
    inputSchema: {
      cloudId: z.string().optional().describe("ID облака (по умолчанию YC_CLOUD_ID)"),
    },
  },
  async ({ cloudId }) => {
    try {
      return jsonResult(await yandex.listFolders(cloudId));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "yc_compute_list_instances",
  {
    title: "Yandex Cloud: ВМ в каталоге",
    description: "Возвращает список виртуальных машин Compute в каталоге. folderId можно опустить, если задан YC_FOLDER_ID.",
    inputSchema: {
      folderId: z.string().optional().describe("ID каталога (по умолчанию YC_FOLDER_ID)"),
    },
  },
  async ({ folderId }) => {
    try {
      return jsonResult(await yandex.listInstances(folderId));
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ─────────────────────────── Запуск ───────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout занят протоколом MCP — логи только в stderr.
  console.error("b24-cloud-mcp запущен (stdio)");
}

main().catch((err) => {
  console.error("Не удалось запустить MCP-сервер:", err);
  process.exit(1);
});

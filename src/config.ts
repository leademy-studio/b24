/**
 * Централизованное чтение переменных окружения для облачных интеграций.
 * Значения подхватываются из .env (через `node --env-file=.env`).
 */

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const config = {
  google: {
    /** Путь к JSON ключу сервис-аккаунта; если не задан — используется Application Default Credentials. */
    credentialsFile: optional("GOOGLE_APPLICATION_CREDENTIALS"),
    /** ID проекта GCP (нужен некоторым вызовам). */
    projectId: optional("GOOGLE_CLOUD_PROJECT"),
  },
  yandex: {
    /** Один из способов аутентификации в Yandex Cloud (в порядке приоритета). */
    oauthToken: optional("YC_OAUTH_TOKEN"),
    iamToken: optional("YC_IAM_TOKEN"),
    /** Путь к JSON ключу сервис-аккаунта (выдаётся `yc iam key create`). */
    saKeyFile: optional("YC_SA_KEY_FILE"),
    /** Дефолтные cloudId / folderId, чтобы не передавать их в каждый вызов. */
    cloudId: optional("YC_CLOUD_ID"),
    folderId: optional("YC_FOLDER_ID"),
  },
} as const;

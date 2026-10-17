import { readFileSync } from 'node:fs';
import { Controller, Get, Header } from '@nestjs/common';

export const OPENAPI_SPEC_PATH = new URL('../../../docs/api/openapi.yaml', import.meta.url);

const SWAGGER_UI_VERSION = '5.17.14';

let cachedSpec: Record<string, unknown> | undefined;

export function loadOpenApiSpec(): Record<string, unknown> {
  cachedSpec ??= Bun.YAML.parse(readFileSync(OPENAPI_SPEC_PATH, 'utf8')) as Record<string, unknown>;
  return cachedSpec;
}

const swaggerUiPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wagering API</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/docs/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>
`;

@Controller('docs')
export class DocsController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return swaggerUiPage;
  }

  @Get('openapi.json')
  spec(): Record<string, unknown> {
    return loadOpenApiSpec();
  }
}

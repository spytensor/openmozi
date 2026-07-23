# Native Office Rendering

MOZI supports an optional local ONLYOFFICE Docs service for editor-grade DOCX, XLSX, and PPTX viewing. The original binary remains the source of truth and is always downloadable. Editing is deliberately disabled until callback persistence and artifact versioning are enabled end to end.

## Why ONLYOFFICE

| Engine | Decision |
|---|---|
| ONLYOFFICE Docs Community | Selected. Local Docker image, Word/Spreadsheet/Presentation editors, OOXML support, JWT integration, and no external CDN. |
| Collabora Online | Viable WOPI alternative, but adds a second protocol/storage integration and does not improve the initial local deployment target. |
| Microsoft Office web embed | Rejected for local-first use. Online Viewer files cannot require authentication and the service is not an offline/local Docker dependency. |
| Mammoth, SheetJS, PDF conversion | Retained only as explicit fallback previews; they are not labeled native. |

ONLYOFFICE Community requires substantial local resources (the vendor recommends at least 4 GB RAM and 40 GB disk), so it is an opt-in Compose profile.
The Community image is currently amd64-only. The Compose service pins `linux/amd64`, so Apple Silicon Macs run it through Docker Desktop emulation; startup and document rendering are slower than on a native amd64 host.

## Local Docker

1. Generate a stable secret: `openssl rand -hex 32`.
2. Set these values in `.env`:

   ```dotenv
   ONLYOFFICE_JWT_SECRET=<generated value>
   OFFICE_DOCUMENT_SERVER_URL=http://localhost:8082
   OFFICE_DOCUMENT_SERVER_INTERNAL_URL=http://onlyoffice
   OFFICE_STORAGE_BASE_URL=http://mozi:9210
   ```

3. Start both services: `docker compose --profile office up -d`.
4. Open a supported Office artifact. MOZI requests an authenticated
   `GET /api/office/session?path=...`; a successful session supplies the signed
   `/api/office/file` URL used by ONLYOFFICE. If session creation fails, the UI
   visibly uses the fallback preview.

The browser loads the editor API from the local `onlyoffice` container. ONLYOFFICE fetches the original file through a ten-minute signed `/api/office/file` URL. The token carries tenant, user, path, and file-version identity; the storage endpoint rechecks the user workspace boundary before serving bytes.

## Fallback And Editing

When the service is absent or unhealthy, MOZI labels the surface `Fallback preview` and uses the existing LibreOffice-to-PDF, Mammoth, or SheetJS viewer. It never calls that path native.

Sessions currently use `mode: view`. Enabling edit mode requires a separate change that verifies ONLYOFFICE callbacks, writes the returned binary to a new artifact version, handles conflict/version keys, and audits the mutation. Turning on `permissions.edit` without that storage contract would lose user changes and is forbidden.

References: [ONLYOFFICE integration architecture](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/), [JWT security](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/security/), and [Community Docker installation](https://helpcenter.onlyoffice.com/docs/installation/docs-community-install-docker.aspx).

#!/bin/bash
# Descarga un snapshot diario de la base de datos de producción y lo guarda
# localmente, sobrescribiendo el anterior. Pensado para ejecutarse por cron
# en una máquina fuera de Railway (el OMEN), para no depender de un único
# proveedor si algo le pasa al volumen de Railway.
#
# Requiere la variable de entorno BACKUP_TOKEN (se pone en el propio
# crontab, nunca en este archivo ni en el repo).
set -euo pipefail

BACKUP_URL="https://club.tatianasilva.es/api/admin/backup"
BACKUP_DIR="$HOME/backups/loyalty-card"
BACKUP_FILE="$BACKUP_DIR/loyalty-backup.db"
TMP_FILE="$BACKUP_FILE.tmp"
LOG_FILE="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

if [ -z "${BACKUP_TOKEN:-}" ]; then
  echo "$(date -Iseconds) ERROR: falta BACKUP_TOKEN en el entorno" >> "$LOG_FILE"
  exit 1
fi

if curl -sf -H "X-Backup-Token: $BACKUP_TOKEN" "$BACKUP_URL" -o "$TMP_FILE"; then
  mv "$TMP_FILE" "$BACKUP_FILE"
  echo "$(date -Iseconds) OK: backup guardado ($(du -h "$BACKUP_FILE" | cut -f1))" >> "$LOG_FILE"
else
  echo "$(date -Iseconds) ERROR: fallo al descargar el backup" >> "$LOG_FILE"
  rm -f "$TMP_FILE"
  exit 1
fi

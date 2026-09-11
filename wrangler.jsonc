{
  "name": "smart-recovery-bot",
  "main": "worker.js",
  "compatibility_date": "2026-09-11",

  "assets": {
    "directory": ".",
    "binding": "ASSETS"
  },

  "durable_objects": {
    "bindings": [
      {
        "name": "XAU_SETUP_LOCK",
        "class_name": "XAUSetupLock"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "XAUSetupLock"
      ]
    }
  ]
}

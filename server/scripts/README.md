# Connexion directe et migration des tâches

Le serveur MCP existant est utilisé directement par Codex, sans dépendre du catalogue mis en cache du plugin ChatGPT.

```sh
codex mcp add teamleader-secure --url https://teamleader-chatgpt.mm-979.workers.dev/mcp
codex mcp login teamleader-secure --scopes teamleader:read,teamleader:write
```

Codex doit pouvoir enregistrer sa configuration et ses verrous OAuth. Une erreur d'écriture dans `mcp-oauth-locks` peut survenir après validation du navigateur : dans ce cas la connexion n'est pas enregistrée. Le CLI doit terminer avec `Successfully logged in`.

Le formulaire OAuth ne peut pas être mis en cache. Il conserve son cookie CSRF obligatoire et autorise la redirection vers l'hôte Teamleader prévu.

## Vérification réelle

`connector-client.mjs` appelle uniquement le serveur MCP configuré, avec les identifiants OAuth de cette connexion Codex. Il ne journalise ni ne copie les jetons dans le projet. Codex reste responsable du renouvellement de sa connexion ; ce client utilise le jeton courant pour la vérification et la migration.

```sh
node scripts/connector-client.mjs tools
node scripts/test-task-connection.mjs /absolute/path/test-report.json
```

Le second script crée une tâche temporaire explicitement nommée, vérifie sa lecture, modification, clôture, réouverture, planification et déplacement, puis annule son créneau et supprime la tâche. Il écrit les identifiants au fil des opérations pour permettre le nettoyage après interruption. Il ne programme pas de notification.

## Migration

1. Exporter les fiches Airtable et vérifier que toutes les pages sont présentes.
2. Générer le plan avec `prepare-airtable-import.mjs source.json first-five.json plan.json`.
3. Résoudre les dates manquantes avec l'utilisateur, les responsables et les types de travail. Résoudre les UUID des cinq tâches existantes ; ne pas passer leurs identifiants numériques de l'interface à l'API.
4. Pour la migration des fiches, préciser `scope: task_records_only` et conserver séparément l'état des documents. Lever uniquement les blocages résolus pour cette phase. Le succès des fiches ne signifie pas que les pièces jointes sont transférées.
5. Prévisualiser : `import-airtable-tasks.mjs plan.json journal.json`.
6. Exécuter l'import autorisé avec `--apply`. Les opérations sont séquentielles, verrouillées localement et suivies dans le journal. Les correspondances reposent sur l'identifiant Airtable et l'URL source stable. Une création au résultat incertain bloque la reprise si elle n'est pas retrouvée.

Les sources modifiées demandent une réconciliation explicite. Les descriptions antérieures des tâches existantes sont conservées lors de l'ajout des données Airtable.

L'API publique Teamleader ne propose pas le dépôt direct de fichiers dans une tâche. Les fichiers d'un ticket lié restent des fichiers de ticket ; ne pas les présenter comme des pièces jointes natives de tâche.

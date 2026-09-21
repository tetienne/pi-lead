# PI LEAD — BOOTSTRAP BRIEF

Document à donner tel quel à un nouvel agent dans un dossier vide


## 1. Mission

Tu dois partir d’un dossier vide et transformer cette vision en un projet autonome, spécifié, découpé en tickets puis implémentable. Ne commence pas par coder.

- Commence par le workflow Matt Pocock disponible : Ask Matt pour confirmer le parcours, puis privilégie grill-with-docs -> to-spec -> to-tickets avant l’implémentation.

- Pose-moi uniquement les questions qui correspondent à de vraies décisions. Recherche toi-même les faits techniques dans les sources primaires.

- Quand une action exige réellement mon intervention (compte, secret, validation, création de repo, choix irréversible), arrête-toi au bon moment et donne-moi une procédure courte et exacte.

- N’invente pas un framework si Pi, Herdr, Gondolin, mise, Jev ou les skills Matt fournissent déjà la primitive.


## 2. Expérience utilisateur cible

1. Je lance Herdr dans mon projet et je reste dans un onglet Lead.

2. Je parle normalement à Pi : « implémente X », « debug Y », « réfléchissons à Z », « review cette branche ».

3. Aucune commande /task n’est obligatoire ; une commande explicite peut exister comme escape hatch.

4. Le Lead choisit le workflow utile et lance seulement les agents nécessaires.

5. Chaque worker important apparaît dans son propre onglet Herdr, bien nommé : research-auth, impl-token-store, review-auth, etc.

6. Après succès, le résultat est récupéré et l’onglet temporaire est fermé. En cas d’échec/BLOCKED, l’onglet reste disponible pour diagnostic.

7. À la fin, le Lead résume ce qui a été fait, les validations, les corrections de review, la branche/les commits utiles et confirme qu’aucun agent inutile ne reste actif.


## 3. Architecture de référence


## 4. Workflow Matt : ne pas inventer un second SDLC

Étudie les contrats réels des skills avant de définir la machine d’état. Au minimum : ask-matt, grill-with-docs, grilling, research, diagnosing-bugs, domain-modeling, codebase-design, prototype, wayfinder, triage, to-spec, to-tickets, implement, tdd, code-review, improve-codebase-architecture, resolving-merge-conflicts, handoff, wizard et writing-for-agents.

Certains skills sont des étapes ; d’autres sont des disciplines transversales. Ne transforme pas mécaniquement chaque skill en état.


## 5. Machine d’état provisoire

Pars d’une machine petite : INTAKE -> DISCOVER / DEBUG / PLAN / READY -> BUILD -> VERIFY -> DONE, avec FIX qui reboucle vers VERIFY et BLOCKED lorsqu’une intervention humaine ou une limite de retry est atteinte.

- Si du code change : validation et review obligatoires.

- Une ambiguïté importante bloque l’implémentation spéculative.

- Une opération privilégiée/production n’est jamais autorisée par Jev ou par le LLM.

- Les boucles review -> fix sont bornées ; au-delà, BLOCKED.

- DONE est déterministe : validations passées, résultats récupérés, ressources temporaires nettoyées.


## 6. Rôle de Jev

Utilise la skill officielle TypeSafe/Jev comme référence. Jev juge ; il ne gouverne pas la sécurité.

- Intent routing : CHAT, IMPLEMENT, IDEATE, DEBUG, REVIEW, RESEARCH, TRIAGE, WAYFIND, OPERATE — catalogue à valider.

- Resource routing au spawn : type de tâche, difficulté, besoin de contexte ; mapping déterministe vers modèle et niveau de reasoning autorisés.

- Jev ne décide jamais permissions, secrets, accès production, bypass de review, sandbox ou définition de DONE.


## 7. Investigation Pi obligatoire

Avant de coder, fais un inventaire exhaustif des hooks, événements, commandes, SDK/RPC et mécanismes d’extensions de la version de Pi réellement utilisée. Pour chacun : moment d’appel, données disponibles, possibilité de modifier/bloquer, sécurité et utilité.

Vérifie notamment les mécanismes envisagés pour l’intake, le before-agent behavior, le changement de modèle et l’observabilité. Ne suppose pas leurs signatures ou sémantiques.

L’extension Pi doit rester mince ; la state machine et la policy doivent être testables indépendamment.


## 8. Investigation Herdr obligatoire

Étudie exhaustivement : workspaces, layouts/tabs, panes, agents, lifecycle/status, prompt/wait/read, socket/API, intégration Pi, session restore, worktrees, metadata, événements, fermeture/nettoyage et remote.

- Le Lead garde le focus quand des workers sont créés.

- Un worker important = un onglet dédié, pas une mosaïque illisible.

- Noms sémantiques et stables.

- Succès : collecter puis fermer. Échec/BLOCKED : conserver pour diagnostic.

- Tous les workers doivent être visibles dans Herdr même si Pi tourne dans une sandbox.


## 9. Sécurité

Considère comme potentiellement hostile : prompt, modèle, repo, dépendances, commandes, skills non officiels et extensions tierces. Une extension Pi n’est jamais une frontière de sécurité.

- Pi worker autonome dans une vraie frontière OS/VM ; Gondolin est le candidat prioritaire à valider.

- Aucun credential host directement accessible au shell du worker.

- Pas de docker.sock, SSH agent, ~/.aws, ~/.kube ou équivalent par défaut.

- Réseau deny-by-default/allowlist lorsque réaliste.

- Opérations privilégiées via policy déterministe et human gate si nécessaire.

- Le Lead de confiance ne partage pas automatiquement ses secrets avec les workers.


## 10. Performance, mise et caches

- Base stable : Pi, mise, git, rg, jq et outils OS.

- mise pilote les versions Node/Go/Python/Terraform/etc. du projet.

- Caches possibles : Go modules/build, pnpm/npm, uv/pip, cargo, Terraform providers.

- Évite un cache RW global entre agents non fiables : base/cache partagé RO + overlay/cache privé par agent, puis promotion contrôlée si nécessaire.

- Le démarrage d’un worker doit être rapide ; mesurer le temps de spawn dès les premiers MVP.


## 11. Questions à me poser

Avec grill-with-docs, clarifie seulement ce qui n’est pas déjà déterminé :

- OS/hôte cible et contraintes de virtualisation.

- Providers/modèles disponibles et limites de coût.

- Règles réseau des agents.

- Opérations exigeant toujours mon approbation.

- Tracker : local d’abord, GitHub Issues, ou autre.

- Politique Git : branches/worktrees, commits/push automatiques ou non.

- Nombre maximal d’agents parallèles et limites de retry.

- Conservation des logs/artifacts.

- Mode d’installation du package dans mes autres projets.


## 12. Quand mon intervention est nécessaire

Ne me donne pas une énorme checklist préventive. Au moment exact où tu as besoin de moi, donne uniquement :

1. Pourquoi mon intervention est nécessaire.

2. La commande, l’URL ou l’action exacte.

3. Ce que je dois vérifier pour confirmer le succès.

4. Ce que je dois te répondre ensuite. Ne me demande jamais de coller un secret dans le chat.


## 13. Ordre de travail obligatoire

Phase 0 — Inspecter — Confirme le dossier vide, les outils disponibles et les versions. Lis les sources primaires actuelles.

Phase 1 — Ask Matt — Confirme le bon parcours Matt pour concevoir ce projet.

Phase 2 — Grill with docs — Interviewe-moi et crée le contexte/ADRs nécessaires.

Phase 3 — Research ciblée — Ferme les incertitudes : Pi<->orchestrateur, Herdr<->sandbox, état/persistance, policy, Jev.

Phase 4 — Spec — Utilise to-spec. Elle doit être autonome : un agent frais doit pouvoir travailler sans cette conversation.

Phase 5 — Tickets — Utilise to-tickets : tracer bullets verticaux + blocking edges. Fais-moi valider la granularité.

Phase 6 — Repository — Après approbation, initialise le repo local. Demande mon intervention pour GitHub uniquement lorsque réellement utile.

Phase 7 — Implémentation — Ticket par ticket, tests aux seams utiles, puis review indépendante.


## 14. Vertical slices recommandés

1. MVP 1 : Lead reçoit une tâche -> crée un worker -> worker visible dans un onglet Herdr -> résultat récupéré -> onglet fermé -> résumé final.

2. MVP 2 : même flux avec vraie isolation du worker + environnement mise rapide/cacheable.

3. MVP 3 : Jev pour intent/model routing avec fallbacks déterministes.

4. MVP 4 : intégration des principaux workflows Matt.

5. MVP 5 : graphe de tickets, frontier scheduler et agents parallèles.

6. Ensuite seulement : budgets avancés, remote agents, métriques/coûts et raffinements UX.


## 15. Contraintes non négociables

- Projet/package réutilisable séparé de mon application actuelle.

- Installation simple dans d’autres repos.

- Minimum d’extensions tierces ; aucune extension communautaire dans le chemin critique sans justification exceptionnelle.

- Une distribution peut contenir plusieurs modules internes : pas de grosse extension monolithique.

- Policy et state machine testables sans Pi ni Herdr.

- Herdr = control plane humain, pas sandbox.

- Gondolin = sécurité, à valider par tests d’évasion/permissions.

- Jev = jugement probabiliste borné par des choix autorisés.

- Matt = workflow d’ingénierie ; adapter plutôt que réinventer.

- Complexity budget : toute abstraction maison doit justifier pourquoi une primitive existante ne suffit pas.


## 16. Livrables avant le premier vrai ticket de code

1. CONTEXT.md avec vocabulaire et objectifs.

2. ADRs pour les décisions structurantes (sécurité, lifecycle, routing, état/persistance).

3. Research notes sourcées pour les contrats techniques incertains.

4. Une spec autonome et approuvée.

5. Un graphe de tickets vertical slices avec dépendances.

6. Une définition explicite de DONE et BLOCKED.

7. Une liste courte des actions manuelles restantes, uniquement si elles sont réellement nécessaires.


## 17. Définition de succès du projet

Le projet est réussi si, depuis un repo consommateur, je peux installer/configurer le package, lancer Herdr, ouvrir le Lead et travailler en langage naturel ; les agents nécessaires sont créés, routés vers des modèles appropriés, isolés, visibles, rapides grâce aux caches, contrôlés par une policy, puis nettoyés automatiquement, tandis que le Lead me rend un résultat final vérifiable.

Priorité absolue : simplicité, sécurité, observabilité et réutilisation — dans cet ordre avant la sophistication.


## 18. Première instruction à exécuter

Tu es maintenant dans un dossier vide. Ne crée encore aucun code applicatif. Commence par :

1. Inspecter l’environnement.

2. Utiliser Ask Matt pour confirmer le workflow.

3. Lancer grill-with-docs avec moi.

4. Identifier les décisions réellement ouvertes.

5. Faire uniquement les recherches primaires nécessaires.

6. Me proposer ensuite la spec avant toute implémentation.

# Nexora-Launcher

![Plateforme](https://img.shields.io/badge/plateforme-Windows-0078D6) ![Electron](https://img.shields.io/badge/Electron-44-47848F) ![Licence](https://img.shields.io/badge/licence-MIT-green)

Le launcher des applis Nexora : chacun crée un compte, ajoute tes applis depuis la **Boutique** à sa **Bibliothèque**, puis les installe et les lance en un clic.
Seuls les membres de l'équipe **Nexora-Team** peuvent publier, mettre à jour ou retirer une appli, et toutes les applis sont publiées sous le nom **Nexora-Team**. Au départ, l'équipe contient louisdelahodde@gmail.com.

Tout est hébergé sur **Supabase** : les comptes, la liste des applis et les fichiers .exe. Tu n'as plus de serveur à faire tourner.

| Fichier ou dossier | Rôle |
|---|---|
| `launcher/` | L'appli de bureau Windows (Electron) que tes potes installent |
| `launcher/config.js` | L'adresse et la clé de ton projet Supabase |
| `supabase/schema.sql` | Prépare la base, le stockage et les règles de sécurité |

## 1. Préparer Supabase (une seule fois)

1. Crée un projet sur [supabase.com](https://supabase.com). L'offre gratuite suffit pour commencer.
2. Ouvre **SQL Editor**, puis **New query**. Colle tout le contenu de `supabase/schema.sql` et clique sur **Run**. Le message « Nexora-Launcher : base prête » confirme que tout est en place. Si tu avais lancé une version précédente du script, relance celle-ci : elle ajoute la bibliothèque et le type de fichier sans rien perdre.
3. Ouvre **Authentication**, puis **Sign In / Providers**, puis **Email**, et choisis l'une des deux options :
   - **Désactiver « Confirm email »** (le plus simple) : tes potes se connectent dès leur inscription. Le service d'e-mail intégré à Supabase n'écrit qu'aux membres de ton équipe Supabase, 2 fois par heure maximum : la confirmation ne leur arriverait jamais.
   - **Garder « Confirm email »**, à condition de brancher ton propre service d'e-mail (Brevo, Resend…) dans **Authentication**, **Emails**, **SMTP Settings**.
4. **Crée ton compte admin avant de partager le launcher.** Dans **Authentication**, **Users**, clique sur **Add user**, puis **Create new user**. Entre louisdelahodde@gmail.com et ton mot de passe, et coche **Auto Confirm User**. Ton adresse étant prise, personne d'autre ne pourra s'inscrire avec.
5. Récupère l'adresse du projet (`https://xxxx.supabase.co`, affichée par le bouton **Connect**) et la clé **publishable** (`sb_publishable_…`, dans **Project Settings**, **API Keys**).

## 2. Relier le launcher à ton projet

Ouvre `launcher/config.js` et remplace les deux valeurs :

```js
supabaseUrl: 'https://xxxx.supabase.co',
supabaseKey: 'sb_publishable_…',
```

N'y mets **jamais** la clé secrète (`sb_secret_…` ou l'ancienne `service_role`) : le launcher refuse de démarrer s'il la trouve.

## 3. Lancer le launcher

Il faut [Node.js](https://nodejs.org) 22 ou plus récent.

```bash
cd launcher
npm install
npm start
```

Connecte-toi avec ton adresse admin : le bouton **Publier une appli** apparaît en bas à gauche.

## 4. Publier une appli

Dans **Publier une appli**, remplis le nom, la version et la description. Choisis ensuite le fichier .exe et une icône (facultative), puis clique sur **Publier l'appli**. L'appli apparaît aussitôt chez tout le monde.

Pour publier une nouvelle version, clique sur **Modifier la fiche** depuis la page de l'appli. Choisis le nouveau .exe, change le numéro de version, puis clique sur **Mettre à jour l'appli**. Chez tes potes, le bouton **Mettre à jour** apparaît, et l'ancien fichier est supprimé de Supabase.

Choisis le **Type de fichier**. Le launcher le devine tout seul quand tu choisis le .exe, et tu peux le changer :

- **Appli autonome** : un .exe qui se lance directement (PyInstaller `--onefile`, .NET en « single file », cible `portable` d'electron-builder…). **Lancer** ouvre ce .exe.
- **Installateur** : un setup classique (NSIS, Inno Setup…). **Installer** télécharge le setup et l'exécute une seule fois. Le launcher retrouve ensuite l'appli installée dans Windows : **Lancer** ouvre l'appli, jamais l'installateur. **Désinstaller** passe par le désinstallateur de l'appli.

Si le launcher ne retrouve pas l'appli installée, il affiche **Localiser l'appli** : choisis son .exe une fois, c'est retenu.

Dans tous les cas, 50 Mo maximum par fichier sur l'offre gratuite de Supabase.

## 5. Donner le launcher à tes potes

1. Vérifie que `launcher/config.js` contient l'adresse et la clé publishable de ton projet.
2. Sur un PC Windows, dans `launcher` : `npm install`, puis `npm run dist`.
3. L'installateur se trouve dans `launcher/dist/Nexora-Launcher-Setup-1.0.0.exe`.

L'installateur n'est pas signé, donc Windows SmartScreen peut afficher un avertissement. Clique sur « Informations complémentaires », puis sur « Exécuter quand même ».

## Publier une nouvelle version sur GitHub

Le dépôt contient un workflow GitHub Actions (`.github/workflows/release.yml`) qui construit l'installateur Windows et l'attache automatiquement à une **Release**.

1. Change `"version"` dans `launcher/package.json` (par exemple `1.0.1`).
2. Crée et pousse le tag correspondant :

   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

3. Quelques minutes plus tard, `Nexora-Launcher-Setup-1.0.1.exe` est téléchargeable dans l'onglet **Releases** du dépôt.

## Ajouter ton pote à Nexora-Team

1. Ton pote crée d'abord son compte : dans le launcher avec **Créer un compte**, ou par toi dans **Authentication**, **Users**, **Add user**, avec **Auto Confirm User** coché.
2. Vérifie dans **Authentication**, **Users** que son compte apparaît, avec son adresse confirmée.
3. Dans **SQL Editor**, lance cette ligne avec son adresse en minuscules :

   ```sql
   insert into public.team_members (email) values ('adresse-de-ton-pote@exemple.fr') on conflict (email) do nothing;
   ```

4. Il se déconnecte puis se reconnecte dans le launcher : le bouton **Publier une appli** apparaît, et « Nexora-Team » s'affiche sous son pseudo. Tout ce qu'il publie est signé **Nexora-Team**, comme ce que tu publies.

**L'ordre compte :** ajoute une adresse à l'équipe seulement après la création du compte correspondant. Sinon, si « Confirm email » est désactivé, quelqu'un d'autre pourrait s'inscrire avec cette adresse avant ton pote et obtenir le droit de publier.

Pour voir l'équipe : `select email, added_at from public.team_members order by added_at;`
Pour retirer quelqu'un : `delete from public.team_members where email = 'adresse@exemple.fr';`

## Limites de l'offre gratuite Supabase

- **50 Mo maximum par .exe**, et 1 Go de fichiers au total.
- **Environ 5 Go de téléchargements par mois** : un .exe de 40 Mo installé par 100 personnes en consomme 4.
- **Le projet se met en pause après une semaine sans activité.** Le launcher affiche alors « Supabase ne répond pas ». Réactive le projet depuis le tableau de bord.

L'offre Pro lève ces limites, jusqu'à 500 Go par fichier. Augmente alors `maxUploadMb` dans `launcher/config.js`, ainsi que la limite dans **Storage**, **Settings**.

## Sécurité

- **C'est Supabase qui vérifie le droit de publier**, grâce aux règles de `schema.sql` (Row Level Security). Seuls les comptes de l'équipe (table `team_members`), avec une adresse confirmée, peuvent ajouter, modifier ou supprimer une appli ou un fichier, et le nom d'éditeur est toujours imposé à « Nexora-Team ». Cette règle s'applique même si quelqu'un contourne le launcher.
- La clé publishable livrée dans le launcher ne donne aucun droit particulier : sans compte, on ne voit même pas la liste des applis.
- Les .exe sont dans un espace privé : il faut être connecté pour les télécharger. Le launcher vérifie l'empreinte SHA-256 de chaque fichier après le téléchargement.
- Sur le PC des joueurs, la session est chiffrée par Windows.
- La liste de l'équipe n'est visible et modifiable que depuis le SQL Editor de Supabase, jamais depuis le launcher.

## Où sont les données ?

- Chez les joueurs : `%APPDATA%\Nexora-Launcher\`. Les applis installées sont dans `apps\`.
- Sur Supabase : la table `apps` (dans **Table Editor**) et les buckets `apps` et `icons` (dans **Storage**).

## Limites actuelles

- Il n'y a pas de « mot de passe oublié » dans le launcher, car il faudrait un service d'e-mail. En attendant, tu peux gérer les comptes depuis **Authentication**, **Users**.
- La détection de l'appli installée par un installateur n'a pas pu être testée sur un vrai Windows. Si **Lancer** n'ouvre pas la bonne appli, utilise le lien « Indique son .exe » sous les boutons de la fiche.
- Le launcher ne se met pas à jour tout seul. Pour une nouvelle version du launcher, redistribue l'installateur.

## Licence

Code sous licence [MIT](LICENSE). La police Big Shoulders Display est sous licence [SIL OFL 1.1](launcher/renderer/fonts/OFL.txt).

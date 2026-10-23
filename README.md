# Nexora-Launcher

![Plateforme](https://img.shields.io/badge/plateforme-Windows-0078D6) ![Electron](https://img.shields.io/badge/Electron-44-47848F) ![Licence](https://img.shields.io/badge/licence-MIT-green)

Le launcher des applis Nexora : chacun crée un compte, ajoute tes applis depuis la **Boutique** à sa **Bibliothèque**, puis les installe et les lance en un clic.
Seuls les membres de l'équipe **Nexora-Team** peuvent publier, mettre à jour ou retirer une appli, et toutes les applis sont publiées sous le nom **Nexora-Team**.*


## Sécurité

- **C'est Supabase qui vérifie le droit de publier**, grâce aux règles de `schema.sql` (Row Level Security). Seuls les comptes de l'équipe (table `team_members`), avec une adresse confirmée, peuvent ajouter, modifier ou supprimer une appli ou un fichier, et le nom d'éditeur est toujours imposé à « Nexora-Team ». Cette règle s'applique même si quelqu'un contourne le launcher.
- La clé publishable livrée dans le launcher ne donne aucun droit particulier : sans compte, on ne voit même pas la liste des applis.
- Les .exe sont dans un espace privé : il faut être connecté pour les télécharger. Le launcher vérifie l'empreinte SHA-256 de chaque fichier après le téléchargement.
- Sur le PC des joueurs, la session est chiffrée par Windows.
- La liste de l'équipe n'est visible et modifiable que depuis le SQL Editor de Supabase, jamais depuis le launcher.

## Limites actuelles

- Il n'y a pas de « mot de passe oublié » dans le launcher, car il faudrait un service d'e-mail. En attendant, tu peux gérer les comptes depuis **Authentication**, **Users**.
- La détection de l'appli installée par un installateur n'a pas pu être testée sur un vrai Windows. Si **Lancer** n'ouvre pas la bonne appli, utilise le lien « Indique son .exe » sous les boutons de la fiche.

## Licence

Code sous licence [MIT](LICENSE). La police Big Shoulders Display est sous licence [SIL OFL 1.1](launcher/renderer/fonts/OFL.txt).

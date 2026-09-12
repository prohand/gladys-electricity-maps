# Electricity Maps

Cette intégration lit **l'intensité carbone du réseau électrique** chez
[Electricity Maps](https://www.electricitymaps.com/) et l'expose dans Gladys
sous forme de capteurs, à afficher en graphique et à utiliser dans vos scènes
pour faire tourner vos appareils quand l'électricité est la plus propre.

## Ce que vous obtenez

Un appareil, nommé d'après la zone suivie (par exemple
`Electricity Maps (FR)`), avec trois capteurs :

| Capteur                  | Unité      | Signification                                                  |
| ------------------------ | ---------- | -------------------------------------------------------------- |
| Intensité carbone        | gCO₂eq/kWh | Émissions de l'électricité consommée dans la zone en ce moment |
| Électricité décarbonée   | %          | Part venant des renouvelables **et** du nucléaire              |
| Électricité renouvelable | %          | Part venant des renouvelables uniquement                       |

Les trois conservent leur historique : ils s'affichent en graphique sur votre
tableau de bord.

## Obtenir une clé API

L'accès gratuit est celui qui s'appelle **Home Assistant** — c'est l'offre
prévue pour la domotique personnelle, et elle fonctionne à l'identique pour
Gladys.

1. Créez un compte sur le
   [portail Electricity Maps](https://portal.electricitymaps.com/).
2. Allez dans **Settings → Access** et choisissez l'onglet **Home Assistant**
   (les autres onglets, _Trial_ et _Academic_, sont d'autres offres).
   Activez-le : ses conditions d'usage gratuit sont un usage personnel, non
   commercial et sans revenu — ce que fait un serveur domotique.
3. Allez dans **Settings → API keys**, créez votre clé et copiez-la.
4. Notez votre **zone** : cet accès gratuit donne droit à une zone (votre zone
   d'origine). Les identifiants ressemblent à `FR`, `DE`, `ES`, `GB` ou
   `US-CAL-CISO` ; la liste complète est servie par
   <https://api.electricitymap.org/v3/zones>.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Collez la **clé API** créée avec l'accès Home Assistant.
3. Indiquez la **zone** à suivre (`FR` par défaut).
4. Ajustez si besoin l'**intervalle de rafraîchissement** (900 secondes par
   défaut).
5. Enregistrez, puis cliquez sur **Tester la connexion** : l'intensité carbone
   actuelle de votre zone s'affiche sous le bouton.
6. L'appareil apparaît dans l'onglet **Découverte**, prêt à être ajouté.

### Intervalle de rafraîchissement

C'est Gladys qui pilote l'interrogation : l'intervalle que vous choisissez est
attaché à l'appareil, et Gladys demande le rafraîchissement à ce rythme.
Electricity Maps met ses données à jour environ **une fois par heure**, et les
offres gratuites ont un quota mensuel de requêtes : interroger plus souvent
n'apporte rien. La valeur est bornée entre **300 s** (5 minutes) et
**86 400 s** (1 jour), et une modification s'applique immédiatement, sans
redémarrage.

### Changer de zone

La zone fait partie de l'identité de l'appareil : en changer crée un
**nouvel** appareil. L'ancien n'est plus rafraîchi et peut être supprimé dans
Gladys.

## Idées de scènes

- Lancer le lave-vaisselle ou charger la voiture quand l'intensité carbone
  passe sous un seuil de votre choix.
- Recevoir une notification quand la part décarbonée dépasse 90 %.
- Superposer votre propre consommation et l'intensité du réseau pour voir le
  coût CO₂ de vos habitudes.

## Dépannage

| Message                           | Que faire                                                            |
| --------------------------------- | -------------------------------------------------------------------- |
| `Invalid API token (HTTP 401)`    | Recopiez le token depuis le portail ; il est stocké en secret        |
| `Zone ... not allowed (HTTP 403)` | Votre offre ne couvre pas cette zone — utilisez votre zone d'origine |
| `Unknown zone (HTTP 404)`         | Vérifiez l'identifiant dans la liste des zones                       |
| `quota exceeded (HTTP 429)`       | Augmentez l'intervalle, ou attendez la remise à zéro du quota        |
| `Electricity Maps unreachable`    | Problème réseau ou DNS sur l'hôte Gladys                             |

L'intégration journalise tout ce qu'elle fait : consultez les logs de
l'intégration depuis l'interface Gladys (ou `docker logs` sur l'hôte) avec
`LOG_LEVEL=debug` pour le détail complet.

Certaines zones ne publient pas de répartition de la production à toutes les
heures. Dans ce cas l'intensité carbone est quand même publiée et les deux
pourcentages sont simplement ignorés pour ce tour, au lieu d'être écrits comme
un `0` trompeur.

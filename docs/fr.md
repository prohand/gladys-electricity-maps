# Electricity Maps

Cette intégration lit **l'intensité carbone du réseau électrique** chez
[Electricity Maps](https://www.electricitymaps.com/) et l'expose dans Gladys
sous forme de capteurs, à afficher en graphique et à utiliser dans vos scènes
pour faire tourner vos appareils quand l'électricité est la plus propre.

## Ce que vous obtenez

Un appareil, nommé d'après la zone suivie (par exemple
`Electricity Maps (FR)`), avec trois capteurs :

| Capteur                  | Unité      | Signification                                                  | Offre gratuite |
| ------------------------ | ---------- | -------------------------------------------------------------- | -------------- |
| Intensité carbone        | gCO₂eq/kWh | Émissions de l'électricité consommée dans la zone en ce moment | Oui            |
| Électricité décarbonée   | %          | Part venant des renouvelables **et** du nucléaire              | Oui            |
| Électricité renouvelable | %          | Part venant des renouvelables uniquement                       | Non            |

Les trois conservent leur historique : ils s'affichent en graphique sur votre
tableau de bord.

Ils appartiennent à la catégorie **Capteur carbone du réseau** de Gladys : c'est
ce qui leur donne leur nom, leur icône et leur unité dans l'interface. Si votre
version de Gladys ne connaît pas encore cette catégorie, l'intégration les
publie en capteurs génériques : ils s'affichent alors en **« Inconnu »**, avec
les mêmes valeurs. Mettez Gladys à jour pour récupérer les vrais libellés.

La clé gratuite **Home Assistant** donne accès à un seul point d'entrée de
l'API, celui qui sert l'intensité carbone et la part fossile (donc la part
décarbonée, son complément). La part renouvelable vient d'un autre point
d'entrée, réservé aux offres payantes : l'intégration l'essaie une fois, et si
votre offre la refuse, le capteur reste simplement vide — les deux autres
continuent normalement.

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
4. Notez la **zone** affichée à côté de votre clé : une clé Home Assistant
   gratuite ne couvre que cette zone-là, et il faut l'indiquer à Gladys — il
   nomme et identifie l'appareil avant le premier appel à l'API. Les
   identifiants ressemblent à `FR`, `DE`, `ES`, `GB` ou `US-CAL-CISO` ; la
   liste complète est servie par <https://api.electricitymaps.com/v3/zones>.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Collez la **clé API** créée avec l'accès Home Assistant.
3. Indiquez la **zone** à suivre — la même que sur votre clé (`FR` par défaut).
4. Ajustez si besoin l'**intervalle de rafraîchissement** (900 secondes par
   défaut).
5. Enregistrez, puis cliquez sur **Tester la connexion** : l'intensité carbone
   actuelle de votre zone s'affiche sous le bouton.
6. L'appareil apparaît dans l'onglet **Découverte**, prêt à être ajouté.

### Intervalle de rafraîchissement

L'intégration gère sa propre minuterie et interroge l'API au rythme que vous
choisissez. Electricity Maps met ses données à jour environ **une fois par
heure**, et les offres gratuites ont un quota mensuel de requêtes : interroger
plus souvent n'apporte rien. La valeur est bornée entre **300 s** (5 minutes)
et **86 400 s** (1 jour). Une modification s'applique immédiatement, sans
redémarrage, et déclenche un rafraîchissement dans la foulée.

Gladys sait piloter lui-même l'interrogation d'un appareil, mais uniquement
avec une liste figée d'intervalles plafonnée à une minute : beaucoup trop
rapide pour une API horaire et à quota. C'est pourquoi les appareils sont
publiés sans `poll_frequency`.

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

| Message                            | Que faire                                                            |
| ---------------------------------- | -------------------------------------------------------------------- |
| `Invalid API token ... (HTTP 401)` | Token mal recopié, **ou** zone différente de celle de votre clé      |
| `Zone ... not allowed (HTTP 403)`  | Votre offre ne couvre pas cette zone — utilisez votre zone d'origine |
| `Unknown zone (HTTP 404)`          | Vérifiez l'identifiant dans la liste des zones                       |
| `quota exceeded (HTTP 429)`        | Augmentez l'intervalle, ou attendez la remise à zéro du quota        |
| `Electricity Maps unreachable`     | Problème réseau ou DNS sur l'hôte Gladys                             |

### Les capteurs restent affichés en « Inconnu »

Deux causes possibles :

1. **Votre Gladys ne connaît pas encore la catégorie.** Les logs de
   l'intégration le disent (`does not know the grid carbon sensors yet`) :
   mettez Gladys à jour, puis reprenez le point 2.
2. **L'appareil a été créé avant.** Gladys ne réécrit pas la catégorie des
   fonctionnalités d'un appareil déjà créé : supprimez l'appareil
   `Electricity Maps (...)` dans **Réglages → Appareils**, puis ajoutez-le à
   nouveau depuis l'onglet **Découverte** de l'intégration. L'historique de
   l'ancien appareil est perdu, les valeurs repartent de zéro.

L'intégration journalise tout ce qu'elle fait : consultez les logs de
l'intégration depuis l'interface Gladys (ou `docker logs` sur l'hôte) avec
`LOG_LEVEL=debug` pour le détail complet.

Certaines zones ne publient pas de données à toutes les heures. Dans ce cas la
valeur manquante est simplement ignorée pour ce tour, au lieu d'être écrite
comme un `0` trompeur.

L'offre gratuite est limitée à **une zone** et à **50 requêtes par heure** :
avec l'intervalle par défaut (900 s), l'intégration en consomme 4 par heure.

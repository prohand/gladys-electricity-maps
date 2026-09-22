# Electricity Maps

Cette intégration lit **l'intensité carbone du réseau électrique** chez
[Electricity Maps](https://www.electricitymaps.com/) et l'expose dans Gladys
sous forme de capteurs, à afficher en graphique et à utiliser dans vos scènes
pour faire tourner vos appareils quand l'électricité est la plus propre.

Elle fournit aussi un **widget** pour le tableau de bord, un **déclencheur** et
une **action** pour vos scènes. Elle demande **Gladys 5.1.0 ou plus récent**.

## Ce que vous obtenez

Un appareil, nommé d'après la zone suivie (par exemple
`Electricity Maps (FR)`), avec deux ou trois capteurs selon votre offre :

| Capteur                  | Unité      | Signification                                                  | Offre gratuite |
| ------------------------ | ---------- | -------------------------------------------------------------- | -------------- |
| Intensité carbone        | gCO₂eq/kWh | Émissions de l'électricité consommée dans la zone en ce moment | Oui            |
| Électricité décarbonée   | %          | Part venant des renouvelables **et** du nucléaire              | Oui            |
| Électricité renouvelable | %          | Part venant des renouvelables uniquement                       | Non            |

Ils conservent tous leur historique : ils s'affichent en graphique sur votre
tableau de bord.

Ils appartiennent à la catégorie **Capteur carbone du réseau** de Gladys : c'est
ce qui leur donne leur nom, leur icône et leur unité dans l'interface. Si votre
version de Gladys ne connaît pas encore cette catégorie, l'intégration les
publie en capteurs génériques : ils s'affichent alors en **« Inconnu »**, avec
les mêmes valeurs. Mettez Gladys à jour pour récupérer les vrais libellés.

La clé gratuite **Home Assistant** donne accès à un seul point d'entrée de
l'API, celui qui sert l'intensité carbone et la part fossile (donc la part
décarbonée, son complément). La part renouvelable vient d'un autre point
d'entrée, réservé aux offres payantes : l'intégration l'interroge **une fois**,
avant de publier l'appareil. Si votre offre la refuse, le capteur
« Électricité renouvelable » n'est **pas publié du tout** — plutôt qu'affiché
vide en permanence — et les deux autres continuent normalement. Passez à une
offre qui sert le détail de production et il apparaît au redémarrage suivant de
l'intégration.

Si vous aviez déjà ajouté l'appareil avec ses trois capteurs, Gladys garde ceux
qui existent : supprimez l'appareil et rajoutez-le depuis l'écran
**Découverte** pour ne plus voir le capteur vide.

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
6. L'appareil apparaît dans l'onglet **Découverte**, prêt à être ajouté. Tant
   que la clé API n'est pas enregistrée, l'intégration ne propose **aucun
   appareil** : il ne pourrait afficher que des capteurs vides.

### Intervalle de rafraîchissement

L'intégration gère sa propre minuterie et interroge l'API au rythme que vous
choisissez. Electricity Maps met ses données à jour environ **une fois par
heure**, et les offres gratuites ont un quota mensuel de requêtes : interroger
plus souvent n'apporte rien. La valeur est bornée entre **300 s** (5 minutes)
et **86 400 s** (1 jour). Une modification s'applique immédiatement, sans
redémarrage, et déclenche un rafraîchissement dans la foulée. Changer la clé
API ou la zone provoque également une lecture immédiate.

Quand vous ajoutez l'appareil depuis l'onglet **Découverte**, ses capteurs sont
remplis tout de suite : pas besoin d'attendre le prochain rafraîchissement.

Gladys sait piloter lui-même l'interrogation d'un appareil, mais uniquement
avec une liste figée d'intervalles plafonnée à une minute : beaucoup trop
rapide pour une API horaire et à quota. C'est pourquoi les appareils sont
publiés sans `poll_frequency`.

### Changer de zone

La zone fait partie de l'identité de l'appareil : en changer crée un
**nouvel** appareil. L'ancien n'est plus rafraîchi et peut être supprimé dans
Gladys.

## Le widget du tableau de bord

Depuis Gladys 5.1, l'intégration ajoute une carte **Carbone du réseau** dans le
sélecteur de widgets de votre tableau de bord. Elle affiche :

- la **zone** suivie, le **niveau carbone** du moment et l'ancienneté de la
  dernière mesure ;
- une tuile par capteur (intensité carbone, part décarbonée et, si votre offre
  la sert, part renouvelable), dont le **chiffre est coloré** selon ce qu'il
  dit : l'intensité carbone prend la couleur de son niveau, les deux
  pourcentages passent du vert (70 % et plus) à l'orange (40 % et plus) puis au
  rouge — les mêmes couleurs que les badges de la liste des appareils ;
- un **graphique** de l'intensité carbone sur les dernières 24 heures ;
- un bouton **Actualiser** (interroge Electricity Maps tout de suite) et un lien
  vers la carte en direct de votre zone.

Les tuiles sont rafraîchies à chaque lecture d'Electricity Maps : la carte est
re-sollicitée juste après chaque relève, donc les chiffres suivent la même
cadence que les capteurs.

Le graphique, lui, s'appuie sur l'appareil : tant que vous ne l'avez pas ajouté
depuis l'écran **Découverte**, la carte affiche quand même les valeurs, sans le
graphique, et vous le rappelle.

### Ce que la couleur coûte

Gladys ne colore le chiffre d'une tuile que si la carte porte elle-même la
valeur : une tuile branchée sur la feature de l'appareil est rendue par le
composant du cœur, qui ignore la couleur demandée. La carte envoie donc ses
propres chiffres, avec deux conséquences :

- l'unité de l'intensité carbone s'affiche **`g/kWh`** et non `gCO₂eq/kWh` :
  une unité de tuile tient en 6 caractères, au-delà le cœur tronque. La liste
  des appareils, elle, garde l'unité complète ;
- les tuiles ne suivent plus les états en temps réel : elles sont redessinées à
  chaque re-lecture de la carte. En pratique cela ne change rien, la boucle de
  relève sollicite le widget juste après chaque mesure — c'est-à-dire au moment
  précis où un chiffre change.

Enfin, la couleur teinte le **texte** du chiffre ; elle ne dessine pas une
pastille pleine comme dans la liste des appareils. Le vocabulaire des widgets
ne propose pas de badge sur une tuile.

## Le niveau carbone

L'intensité carbone est un nombre ; le **niveau** est sa lecture en cinq
paliers, utilisée par le widget et par le déclencheur de scène :

| Niveau      | Intensité carbone    |
| ----------- | -------------------- |
| Très faible | < 100 gCO₂eq/kWh     |
| Faible      | 100 – 200 gCO₂eq/kWh |
| Modéré      | 200 – 400 gCO₂eq/kWh |
| Élevé       | 400 – 600 gCO₂eq/kWh |
| Très élevé  | ≥ 600 gCO₂eq/kWh     |

Les paliers sont fixes et identiques pour toutes les zones : une scène veut dire
la même chose d'une semaine à l'autre. Une marge de 10 gCO₂eq/kWh empêche une
valeur posée sur une frontière de faire changer le niveau à chaque mesure.

## Déclencheur de scène

Dans l'éditeur de scènes, catégorie **Intégrations** :

**« Le niveau carbone du réseau a changé »** — se déclenche quand votre zone
passe d'un palier à un autre. Vous pouvez filtrer :

- sur le **nouveau niveau** (par exemple uniquement « Très faible » et
  « Faible ») ;
- sur le **sens** (le réseau devient plus propre, ou plus sale).

Laissez un filtre vide pour réagir à tous les cas.

Il se déclenche **une fois par changement**, pas à chaque rafraîchissement, et
jamais à la première mesure après un démarrage (rien n'a changé, l'intégration
vient juste de commencer à regarder).

La scène peut réutiliser les valeurs de l'événement :
`{{triggerEvent.data.level}}`, `previous_level`, `direction`, `zone`,
`carbon_intensity`, `carbon_free_percentage`, `renewable_percentage`.

> Pour un simple seuil (« quand l'intensité passe sous 80 »), utilisez le
> déclencheur standard de Gladys sur la valeur du capteur : c'est fait pour ça.
> Le déclencheur de l'intégration sert au **changement de palier**, que Gladys
> ne sait pas exprimer tout seul.

## Action de scène

**« Lire les données carbone du réseau »** — met les valeurs de votre zone à
disposition des actions suivantes de la scène :
`zone`, `level`, `carbon_intensity`, `carbon_free_percentage`,
`renewable_percentage` et `age_seconds` (l'âge de la mesure, en secondes).

Une case **« Interroger Electricity Maps d'abord »**, décochée par défaut,
force une lecture en direct. Laissez-la décochée dans la plupart des cas : la
donnée ne bouge qu'environ une fois par heure et les offres gratuites ont un
quota mensuel de requêtes.

## Idées de scènes

- Lancer le lave-vaisselle ou charger la voiture quand le niveau carbone passe
  à « Très faible » ou « Faible » (déclencheur de l'intégration).
- Lancer le lave-vaisselle ou charger la voiture quand l'intensité carbone
  passe sous un seuil de votre choix (déclencheur standard sur le capteur).
- Recevoir une notification quand la part décarbonée dépasse 90 %.
- Envoyer un message contenant l'intensité du moment : action **Lire les
  données carbone du réseau**, puis une notification utilisant
  `carbon_intensity`.
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

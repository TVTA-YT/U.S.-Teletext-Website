<!doctype html>
<!-- Created August 10, 2026, 17:46 -->
<html lang="en" data-bs-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
     <link rel="stylesheet" href="../css/styles.css" />
    <link rel="stylesheet" href="../css/media.css" />
    <link rel="stylesheet" href="../css/navigation-bar-animation.css" />
    <link
      href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap"
      rel="stylesheet"
    />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.min.css">
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
      rel="stylesheet"
      integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB"
      crossorigin="anonymous"
    />
    <script
      src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"
      integrity="sha384-FKyoEForCGlyvwx9Hj09JcYn3nv7wiPVlz7YYwJrWVcXK/BmnVDxM+D2scQbITxI"
      crossorigin="anonymous"
    ></script>
    <title>Available Archives</title>
    <style>
      .container {
        padding-top: 90px;
      }

      th,
      td {
        justify-content: center;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <nav class="navbar navbar-expand-lg fixed-top">
      <div class="logo">
        <a href="../index.html" class="navbar-brand">
          <svg
            class="site-logo"
            id="Layer_1"
            data-name="Layer 1"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 363.15 91.12"
          >
            <defs>
              <style>
                .cls-1 {
                  font-family: ContourGenerator-Regular, "Contour Generator";
                  font-size: 43.32px;
                }

                .cls-2 {
                  letter-spacing: -0.02em;
                }

                .cls-3 {
                  letter-spacing: -0.03em;
                }
              </style>
            </defs>
            <text class="cls-1" transform="translate(0 36.54)">
              <tspan class="cls-2" x="0" y="0">U.S</tspan>
              <tspan x="82.96" y="0">. TELETEXT</tspan>
              <tspan x="62.34" y="43.32">A</tspan>
              <tspan class="cls-3" x="102.93" y="43.32">R</tspan>
              <tspan x="139.66" y="43.32">CHIVE</tspan>
            </text>
          </svg>
        </a>
      </div>
      <button
        class="navbar-toggler mx-4"
        type="button"
        data-bs-toggle="collapse"
        data-bs-target="#navbarNav"
        aria-controls="navbarNav"
        aria-expanded="false"
        aria-label="Toggle navigation"
      >
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav">
          <li class="nav-item desktop-link">
            <a class="nav-link" aria-current="page" href="services.html"
              >Services</a
            >
          </li>
          <li class="nav-item mobile-link">
            <a class="nav-link" aria-current="page" href="services.html"
              >Teletext Services</a
            >
          </li>
          <li class="nav-item desktop-link">
            <a class="nav-link" href="archiving-teletext.html"
              >Archiving Teletext</a
            >
          </li>
          <li class="nav-item mobile-link">
            <a class="nav-link" href="archiving-teletext.html"
              >Archiving Teletext</a
            >
          </li>
          <li class="nav-item desktop-link">
            <a class="nav-link" href="teletext-links.html">Teletext Links</a>
          </li>
          <li class="nav-item mobile-link">
            <a class="nav-link" href="teletext-links.html">Teletext Links</a>
          </li>
          
          <li class="nav-item desktop-link">
            <a class="nav-link" href="about.html">About</a>
          </li>
          <li class="nav-item mobile-link">
            <a class="nav-link" href="about.html">About</a>
          </li>
        </ul>
      </div>
    </nav>
    <main>
      <div class="container">
        <?php

        require 'database.php';

        if (!isset($_GET['year']) || trim($_GET['year']) === '') {
          die('No year specified');
        }

        $year = trim($_GET['year']);

        if (!$conn) {
          die('Connection failed.' . mysqli_connect_error());
        }

        $sql = "SELECT * FROM ExtraVision
                WHERE `Year` LIKE CONCAT('%', ?, '%')
                ORDER BY FIELD(`Month`,
                'January','February','March','April',
                'May','June','July','August',
                'September','October','November','December'), `Date`";

        $stmt = mysqli_prepare($conn, $sql);

        $stmt = mysqli_prepare($conn, $sql);
        if (!$stmt) {
          die('Prepare failed: ' . mysqli_error($conn));
        }

        mysqli_stmt_bind_param($stmt, 's', $year);
        mysqli_stmt_execute($stmt);
        $result = mysqli_stmt_get_result($stmt);

        $downloadDirectory = "../zip/";

        $totalResults = mysqli_num_rows($result);

        echo "<h2 class='display-2 fw-bold'>" . htmlspecialchars($year, ENT_QUOTES, 'UTF-8') . "</h2>";
        echo "<p class='fs-2'>Archived samples: " . $totalResults . "</p>";
        echo "<div class='row'>";

        if (mysqli_num_rows($result) === 0) {
          echo "<p>No programs found for this year.</p>";
        } else {
          $currentMonth = null;

          while ($row = mysqli_fetch_assoc($result)) {
            $recordMonth = htmlspecialchars($row['Month'], ENT_QUOTES, 'UTF-8');
            $recordDate = htmlspecialchars($row['Date'], ENT_QUOTES, 'UTF-8');
            // $recordTime = htmlspecialchars($row['Time'], ENT_QUOTES, 'UTF-8');
            $networkAffiliate = htmlspecialchars($row['Affiliate'], ENT_QUOTES, 'UTF-8');
            $programTitle = htmlspecialchars($row['Program_Title'], ENT_QUOTES, 'UTF-8');
            $tapeType = htmlspecialchars($row['Tape_Type'], ENT_QUOTES, 'UTF-8');
            $availableZIP = htmlspecialchars($row['ZIP'], ENT_QUOTES, 'UTF-8');
            $downloadLink = htmlspecialchars($row['Download_Link'], ENT_QUOTES, 'UTF-8');

            if ($recordMonth !== $currentMonth) {
              if ($currentMonth !== null) {
                echo "</tbody></table></div>";
              }

              $currentMonth = $recordMonth;

              echo <<<HTML
                <div class="col-xl-6 col-lg-6 col-md-6 col-sm-12">
                  <h1>{$recordMonth}</h1>
                  <table class="table table-bordered table-primary table-striped justify-content-center align-middle">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <!-- <th>Time</th> -->
                        <th>Affiliate</th>
                        <th>Program</th>
                        <th>Tape</th>
                        <th>ZIP?</th>
                      </tr>
                    </thead>
                    <tbody>
              HTML;
            }
            $zipCell = ($downloadLink === '')
            ? "<i class='bi bi-slash-circle'></i>"
            : "<a href='$downloadDirectory/$downloadLink'><i class='bi bi-file-zip'>$availableZIP</i></a>";
            
            echo <<<HTML
            <tr>
              <td>{$recordDate}</td>
              <td>{$networkAffiliate}</td>
              <td>{$programTitle}</td>
              <td>{$tapeType}</td>
              <td>{$zipCell}</td>
            </tr>
        HTML;
          }
          echo "</tbody></table></div></div>";

          mysqli_stmt_close($stmt);
        }
        ?>
        </div>
        
      </div>
    </main>
    <footer class="end-footer pt-4 text-center">
      <div id="footer-site-links">
        <img
          src="../images/logo-white-2.png"
          alt
          class="mw-100 pt-2 pb-4 footer-logo"
        />
        <p>
          Issues? &nbsp;
          <a href="https://github.com/TVTA-YT/U.S.-Teletext-Website" target="_blank" style="color: #fff">Report on GitHub.</a>
        </p>
        <p>
          Have questions or information? &nbsp;
          <a href="#" style="color: #fff">Email me.</a>
        </p>
        <p class="pb-4">
          Looking for a specific page? &nbsp;
          <a href="sitemap.html" style="color: #fff">Site map.</a>
        </p>
      </div>
      <div class="pt-4">
        <small class="text-white">&copy; Copyright 2026</small>
      </div>
      
    </footer>
  </body>
</html>

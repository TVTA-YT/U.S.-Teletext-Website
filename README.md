# The U.S. Teletext Archive

![images/white-logo-2.png](images/logo-white-2.png)

## REPOSITORY UPDATE

As of September 12, 2026, I have migrated the site away from using a GitHub Action that fetched database values from a VPS and exported them into JSON files. The database has migrated to Cloudflare. All requests made to the database will now go through Cloudflare instead of requests being made to pre-generated JSON files. With this change, the PHP directory is now depreciated since PHP is no longer being used to fetch database values from the VPS. The use of the VPS has been retired. Database values will now update instantaneously when a new record is added instead of starting the GitHub Action to update the necessary JSON files.

## Repository Information

This repository contains code and files for a website that will host information about and pages for decoded U.S. teletext. This website is a work in progress. As more progress is made, this README will be updated.

In this repository are the main HTML pages. Also included are the following directories:

- `css` contains the style sheets for the website, such as the main style sheets. SASS is used in this project.
- `fonts` contains any external fonts used on the site.
- `html` contains all HTML pages except for the index.html file.
- `images` contains images used on the site.
- `js` contains the scripts used on the site.
- `json` only contains one file that it used to store information used for the "Electra Trivia" page.

## Some Background
For the last few years, European teletext has been able to be decoded thanks to software tools such as [VHS-Teletext](https://github.com/ali1234/vhs-teletext). However, due to the different broadcast standards used in both Europe and the U.S. (PAL vs NTSC), there had been no working method to decode North American teletext. Another issue was that the U.S. has two teletext standards: World System Teletext (WST, also used in Europe) and the North American Broadcast Teletext Specification (NABTS). Also, teletext was not as popular in the U.S. as it was in Europe.

In August 2026, a milestone was reached: U.S. teletext could now be properly decoded thanks to the further development of [Decode-Orc](https://github.com/decode-orc/decode-orc). With this development, pages from U.S. teletext services such as will finally be seen for the first time since these pages were transmitted via the networks' VBI, possibly for the first time ever. Some of the teletext services available in the U.S. follow:

- **DaTaVizion** **[WST]**
    - Networks: KCIU-TV (San Jose, CA) | Discovery Channel
    - Appx. mid-1980s - Appx. 1989
- **Electra** **[WST]**
    - Networks: (TBS | Various local stations)
    - Appx. 1982 - June 11, 1993
    - *The national version of Electra launched on January 1, 1985.*
- **ExtraVision** **[NABTS]**
    - Network: CBS
    - April 4, 1983 - Appx. 1992
- **Keyfax** **[WST]**
    - Networks: TBS | WFLD-TV (Chicago, IL)
    - Appx. 1982 - Appx. mid-1985
- **NBC Teletext** **[NABTS]**
    - Network: NBC
    - May 16, 1983 - Appx. late 1985
 - **SSS Teletext** **[WST]**
    - Network: TBS
    - June 11, 1993 - Appx. 1997
- **Virtext** **[WST]**
    - Network: WGN-TV (Chicago, IL)
    - 1980s - Appx. late 1980s

\*NOTE: Keyfax was transmitted on TBS from 1982-1985 in magazine 1. Electra took over magazine 1 on TBS after Keyfax's closure, while Tempo remained in magazine 2.

## Overall Purpose

With there being existing software tools to decode European teletext, there are a few websites dedicated to hosting archives of those European services, such as the BBC's Ceefax service. Now, with there being available software to decode North American NABTS and WST services, a proper archival website was needed to host these newly-decoded samples - that's the purpose of this website. The goal is to make these samples widely available to anyone who wants download them. Samples are provided as ZIP files. Included in the ZIP archives are the decoded images and, depending on the service, a T33 (NABTS) or T34 (WST) file, which contains the raw teletext stream. All decoded images can also be viewed on the site.

Created August 10, 2026, 13:50

Updated September 12, 2026, 04:12
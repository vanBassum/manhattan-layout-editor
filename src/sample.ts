// Test circuit exported from EasyEDA as Telesis netlist (.tel).
export const SAMPLE_NAME = 'Netlist_Schematic1'

export const SAMPLE_NETLIST = `$PACKAGES
C0201 ! C0201 ! '2.2µF' ; C1 
C0201 ! C0201 ! 100nF ; C2 C4 
CAP-SMD_BD3.0-L3.3-W3.3-RD ! CAP-SMD_BD3.0-L3.3-W3.3-RD ! '220µF' ; C3 C5 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! '10Ω' ; R4 R9 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! '220Ω' ; R3 R10 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! '22Ω' ; R5 R8 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! '82Ω' ; R2 R7 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! 1 ; R12 R13 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! 12k ; R1 R11 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! 1k ; R6 
R_AXIAL-0.4 ! R_AXIAL-0.4 ! LOAD ; RL1 
,
        RES-ADJ-TH_3P-L9.5-W9.5-P2.54-BR-BS ! RES-ADJ-TH_3P-L9.5-W9.5-P2.54-BR-BS ! 1k2 ,
        ; RV1 
TO-126-3_L7.6-W2.7-P2.30-L ! TO-126-3_L7.6-W2.7-P2.30-L ! '{Value}' ; Q2 Q5 
TO-92-3_L4.9-W3.7-P2.54-L ! TO-92-3_L4.9-W3.7-P2.54-L ! '{Value}' ; Q1 Q3 Q4 
$A_PROPERTIES
$NETS
'$1N12' ; Q1.1 R4.2 
'$1N14' ; Q2.2 R5.1 R12.1 
'$1N15' ; Q5.2 R8.1 R13.2 
'$1N16' ; Q4.3 R8.2 
'$1N17' ; Q4.1 R9.1 
'$1N18' ; Q5.3 R9.2 R10.2 
'$1N19' ; Q4.2 R7.2 
'$1N3' ; Q1.3 R5.2 
'$1N31' ; Q3.2 R6.2 RV1.3 
'$1N32' ; Q3.3 R6.1 R7.1 R11.2 
'$1N33' ; C1.1 Q3.1 R1.1 R2.1 RV1.1 RV1.2 
'$1N5' ; Q2.3 R3.1 R4.1 
'$1N6' ; Q1.2 R2.2 
'V-' ; C4.1 C5.2 Q5.1 R10.1 R11.1 
'V+' ; C2.1 C3.1 Q2.1 R1.2 R3.2 
GND ; C2.2 C3.2 C4.2 C5.1 RL1.1 
VIN ; C1.2 
VOUT ; R12.2 R13.1 RL1.2 
$SCHEDULE
$END
`
